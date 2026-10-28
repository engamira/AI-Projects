# Phase A — Architecture and UX proposal: multilingual email production redesign

Status: PROPOSAL for review. No code has been changed. Nothing is built until you approve (and answer the questions in section 9).
Written for: the product owner, to approve or amend before Phase B.

---

## 1. Current architecture and technical risks

### What exists today (verified in the repository)
- **Monorepo**: `@cl/shared` (pure logic: blocks, content schema, conditions, versions, contacts), `@cl/server` (Fastify, Postgres/Neon, MJML), `@cl/web` (React). 213 unit tests, 5 browser suites (smoke, editor, brand, mobile, audience).
- **One campaign = one row** (`campaign.draft_content` JSONB). The email, every language email (`variants[]`), the build mode (`versioning.mode`), mappings (`versioning.routes`) and removed segments (`versioning.removed`) all live inside that one JSON document.
- **One revision stream per campaign** (`campaign_revision`, immutable by trigger, UNIQUE(campaign_id, number)). A revision snapshots the *whole* campaign including every language.
- **Rules**: `shared/conditions.ts` is already a single pure evaluator (AND/OR groups up to 3 levels, 9 comparisons), used by preview, rendering and segment derivation. `shared/versions.ts` derives rule segments ("atoms", control values) from it.
- **Audience**: contacts + custom fields (global), `campaign_audience` (segment fields), `campaign_test_contact` (made-up `.invalid` contacts keyed by a segment *code string*).
- **Roles/permissions** (server-enforced, `access.ts`): Admin, Builder, QA reviewer; capabilities `campaign.edit`, `campaign.submit`, `qa.review`, `qa.approve`, `html.custom`, … already defined. `activity_log` is append-only (DB trigger).
- **Not built yet**: QA checks (M5), submit/approval (M6), sending (M7), reports/backups (M8). So the QA/Builder-to-Check half of your brief is **greenfield — no migration risk**, and this is the cheapest moment to get it right.

### Weaknesses this brief exposes
1. **Revisions are per campaign, not per language.** Your brief needs German-Email to have its own Revision 1-2-3, its own QA submission and approval. Today all languages share one stream and one hash, so approving German would approve everything. This is the biggest structural change.
2. **Two competing segment ideas.** Contact-list segments chosen by fields (up to 10) vs. segments derived from block rules. Plus a third concept, the "mapping" panel (send one segment another's email), a fourth, `removed` lists. This is the "repeated patching" you describe.
3. **Derived audiences are created by the browser** (`derivedSync.ts` calls the API after a 1.8 s delay). Not transactional, can race, can leave obsolete rows. Must move server-side.
4. **Test contacts are identified by a name string** (`UAE-en`); names are recomputed in several places (shared, server label, three UI files).
5. **Rules lack features in the brief**: no NOT, no explicit hide rules (only "show when"), and scenario generation is a full cartesian product (grows fast).
6. **UI code is large and mixed**: `EditorPage.tsx` (813 lines) holds editor, version bar, preview, versions; `SegmentsPane.tsx` (402) holds four concerns.
7. **Operational**: Neon idle-connection drops made tests flaky (mitigated). A redesign multiplies queries per save (regenerating segments/audiences), so it must stay in one transaction.

### Reusable as-is
Block library and editor canvas, MJML rendering, brand/asset library, personalization, auth/roles/audit log, the condition evaluator, contact fields, test harness and CI.

---

## 2. Proposed data model

Naming: I keep the table `campaign` and call it **Project** in the interface only if you want (decision Q8). New tables are additive.

| Entity | Table | Key columns / constraints |
|---|---|---|
| LanguageRegistry | `language` (global, seeded) | `id` (stable slug, e.g. `de`), `locale` (BCP-47, e.g. `de-DE`), `name`, `native_name`, `direction` (ltr/rtl), `active`, `sort`. UNIQUE(locale) |
| Project languages | `campaign_language` | `campaign_id`, `language_id`, `position` (English first). PK(campaign_id, language_id) |
| EmailVariant | `email_variant` | `id`, `campaign_id`, `language_id`, `name` (`German-Email`), `source_variant_id` (cloned from), `draft_content` JSONB (blocks+settings), `draft_version`, `draft_hash`. UNIQUE(campaign_id, language_id). One master: English |
| EmailRevision | `email_revision` | `id`, `variant_id`, `number`, `content`, `content_hash`, `kind`, `label`, `created_by`, `created_at`. UNIQUE(variant_id, number). **Immutable by trigger** (like today) |
| Block | inside `content` JSON | `id` (unique within the variant; clones get fresh ids), props, `rules[]` |
| ConditionalRule | inside the block JSON (see below) | `id`, `effect` show/hide, `when` expression |
| DerivedSegment | `derived_segment` | `id`, `campaign_id`, `variant_id`, `fingerprint` (canonical hash of the predicate), `label`, `predicate` JSON, `rule_ids[]`. UNIQUE(campaign_id, variant_id, fingerprint). Regenerated, never hand-edited |
| TestAudience | `test_audience` (replaces `campaign_test_contact`) | `id`, `campaign_id`, `language_id`, `kind` baseline/scenario, `fingerprint`, `label` (`UAE VIP English-Audience`), `attributes` JSON, `polarity` positive/negative, `expected` JSON (which blocks must show/hide), made-up `.invalid` address. UNIQUE(campaign_id, fingerprint). Test fixtures only |
| QASubmission | `qa_submission` | `id`, `variant_id`, `revision_id` (FK → immutable revision), `submitted_by`, `assigned_to`, `created_at`, `state` |
| QARun | `qa_run` | `id`, `submission_id`, `kind` deterministic/ai, `check_set_version`, `started_at`, `finished_at` |
| QAIssue | `qa_issue` | `id`, public number (`QA-0042`), `run_id`, `submission_id`, `revision_id`, `fingerprint`, `check_id`, `category`, `severity`, `source` deterministic/ai, `description`, `evidence` JSON, `status` |
| CorrectionWorkItem | `correction_item` | `id`, `issue_id`, `assigned_to` (builder), `status`, `reviewer_comment`, `retest_submission_id` |
| SuppressionRule | `suppression_rule` | `id`, `check_id`, `fingerprint`, `scope` (project / global), `reason`, `created_by`, `created_at`, `revoked_by`, `revoked_at`. Rows never deleted |
| AuditEvent | existing `activity_log` | append-only (already enforced). Extended with the new action names |
| Approval | `qa_approval` | `submission_id`, `revision_id`, `content_hash`, `reviewer_id`, `approved_at`. CHECK enforced in service + trigger: reviewer ≠ revision author |

**Why rules live inside the revision JSON, not in a mutable `rule` table:** a revision must be an immutable, self-contained snapshot (hash-bound approval is a project rule). A separate mutable table would let a rule change silently alter an approved revision. The *single source of truth* is instead one shared code module (section 5). Rule IDs are stable inside a variant; cloning generates new IDs with the same behavior.

**Deletion behavior:** deleting a variant that has submissions is a soft delete (`archived_at`) — revisions, issues and audit stay. Deleting a variant with no revisions beyond the first is a hard delete after confirmation. Project delete cascades as today (draft only).

**Synchronization (one transaction on every save/clone/delete):** save draft → recompute derived segments and test audiences for that project → upsert by fingerprint, delete rows no longer produced (never rows referenced by a QA run, which are archived). Cloning is idempotent: a client-supplied `request_id` makes a retry return the first result.

---

## 3. Migration strategy (no data deleted)

1. **Back up first**: Neon branch/snapshot + `pg_dump` before migration (needs your OK, in Phase B).
2. **Additive migrations only** (0010+): new tables; old tables untouched and read-only after cut-over.
3. **Backfill, per existing campaign** (script, re-runnable, in one transaction per campaign):
   - Create English `email_variant` from the current Default content (stripped of `variants`).
   - Each existing *language email* (`variants[kind=language]`) → its own `email_variant` with a Revision 1 snapshot taken from current content.
   - Each old `campaign_revision` → an English-variant `email_revision` (same number, hash recalculated on the stripped content; original row kept).
   - Existing test contacts → `test_audience` baseline/scenario rows (re-derived; hand-made ones kept as "custom").
4. **Per-segment copies** (the "separate copy per segment" mode) and `routes`/`removed` have **no equivalent** in the brief. They are preserved untouched as a read-only "Legacy versions" list until you decide (Q1). Nothing is converted silently.
5. **Feature flag** `redesign_v2` per workspace so the old screens stay available until Phase C is signed off. No dual-write needed (one workspace).
6. Rollback = flag off + old tables still intact.

---

## 4. Wireframes

Global top bar: logo · Campaigns · Audience (contacts) · Assets · Brand · **App Settings** · user menu. Inside a project, the tab strip (consistent selection kept in the URL, so reload and links return to the same language and tab):

`Segments · Emails · Audiences · Preview · Versions · QA · Builder to Check`

A language chip bar (English first) is shared by Emails / Preview / Versions / QA so the selected language follows you between tabs.

### Segments
```
┌ Languages list ─────────────────────────────────────────────┐
│ [ English, Arabic, German                    ] [Apply]      │
│  or type: all languages          25 available · 0 unknown   │
│  (English) (Arabic) (German)  ← chips, English first        │
└─────────────────────────────────────────────────────────────┘
┌ Email list ─────────────────────────────────────────────────┐
│ English-Email   ● saved · rev 3   [Create|Edit] [Delete]    │
│ Arabic-Email    not created       [Create from ▾ English-…] │
│ German-Email    ● saved · rev 1   [Edit] [Delete]           │
└─────────────────────────────────────────────────────────────┘
┌ Derived segments (from rules in the emails — read only) ────┐
│ UAE English Segment        1 rule · English-Email           │
│ UAE VIP English Segment    2 rules                          │
│ Not UAE Segment            hide rule                        │
│ (empty state: "Add a show/hide rule to a block to see …")   │
└─────────────────────────────────────────────────────────────┘
```
### Emails
```
 English-Email  (title, large)   [language chips]   saved · rev 3 [Save revision]
 ┌ Blocks ┐ ┌ Canvas ────────────────────┐ ┌ Properties ─────────────┐
 │ library│ │ block  ⓘ Hide if: NOT UAE  │ │ Rules: [Show|Hide] when │
 │        │ │ block  ⓘ Show if: UAE AND  │ │  Country is UAE         │
 │        │ │         VIP                │ │  AND NOT City is …      │
 └────────┘ └────────────────────────────┘ └─────────────────────────┘
```
### Audiences
```
 Baseline (one per language)      en-Audience  ar-Audience  de-Audience
 Scenarios (from rules)           UAE English-Audience  (+) positive
                                  UAE VIP English-Audience (+)
                                  Not UAE-Audience (−) negative / hide
 Each card: attributes, "expects: blocks 2,5 shown · 3 hidden", [Preview]
 Footer: "Test fixtures only — never emailed". Regenerates automatically.
```
### Preview
```
 Email version [German-Email ▾]   Test audience [UAE VIP English-Audience ▾]   [Desktop|Mobile]
 ┌ rendered email ────────────┐  ┌ Why? ─────────────────────────┐
 │                            │  │ Block 3  SHOWN  rule R-12:    │
 │                            │  │   Country = UAE ✓  VIP = yes ✓│
 │                            │  │ Block 5  HIDDEN rule R-14: …  │
 └────────────────────────────┘  └───────────────────────────────┘
```
### Versions
```
 (English) (Arabic) (German●)      ← chips, not a dropdown
 German-Email
  Revision 3 — Latest   today 10:12  Amira   QA: Started       [Open] [Compare ▾] [Send to QA]
  Revision 2            yesterday    Amira   QA: Approved ✓    [Open] [Compare]
  Revision 1            …            Amira   —                 [Open] [Compare]
 Send to QA ▸ revision [Latest saved: Revision 3 ▾]   "Revision 3 will be submitted."
              ⚠ "You have unsaved changes — save a revision first" (never silently included)
```
### QA
```
 Variant         Revision  Status                 
 English-Email   rev 3     Approved               [AI QA]
 German-Email    rev 3     Started                [AI QA]
 ── findings for German-Email rev 3 ───────────────────────────────
 QA-0042  High   Links   Deterministic  "Button link is empty"   evidence…
          [Comment…]  [Ignore ▾ scope]  [Send for Correction]
 QA-0043  Low    Localization  AI suggestion  "Greeting not translated"
 [Approve revision 3]  (disabled while required issues are open)
```
### Builder to Check
```
 Pending for you                                   
 QA-0042  German-Email rev 3  High  "Button link is empty"  QA: "see hero"  [Open block] [Ignore] [Retest]
 Retest: save a new revision first → submits that revision back to QA (never auto-approved)
```
### App Settings
Global suppression rules (review / revoke / audit trail), language registry (activate/deactivate, locale codes), QA check set (enable/disable by Admin), roles reference.

---

## 5. Conditional rules engine (mandatory single source)

**One module** `@cl/shared/rules` (pure TypeScript, no I/O) is the only place rules are understood. Everything else calls it:

| Consumer | Calls |
|---|---|
| Email rendering / preview | `isBlockVisible(block, attrs)` and `explain(block, attrs)` |
| Derived segments | `extractPredicates(variantContent)` |
| Test audiences | `generateScenarios(variantContent, registry, fields)` |
| QA validation | `lintRules(...)` + re-run `isBlockVisible` against each audience's `expected` |

**Model**
```
Expr  = { and:[Expr…] } | { or:[Expr…] } | { not:Expr } | Leaf
Leaf  = { field, cmp, values }            // cmp: is, is_not, contains, …, is_blank, greater, less
Rule  = { id, effect:'show'|'hide', when:Expr }
Block.rules = Rule[]        // 0 or more
```
**Visibility (defined once):** hidden if any `hide` rule matches; else if the block has `show` rules, visible only if one matches; else visible. *Hide wins over show.*
**Missing fields:** treated as blank (as today). Comparisons "is/contains/greater" are false on blank; "is_blank/is_not/NOT(...)" are true. Documented and unit-tested.
**Conflicts:** a block with contradictory rules is reported by `lintRules` (never silently picked).
**Scenario generation (bounded):** per language: one baseline; per rule one *positive* and one *negative* (control) scenario; fields are combined only when they appear in the same expression (e.g. UAE + VIP), duplicates removed by canonical fingerprint, hard cap (default 60 per language) with a visible "too many scenarios" warning. This replaces today's full cartesian product.
**Clone:** `cloneBlocks()` assigns new block and rule ids, same behavior; later edits never touch the source.
The current `conditions.ts` evaluator is the starting point, so existing rules migrate without change (old `showWhen` → one `show` rule).

---

## 6. State diagrams

### Revision lifecycle (per language variant)
```
 draft (autosave, mutable) ──Save revision──► Revision N (immutable, numbered per variant)
 Revision N ──Restore──► draft ──Save──► Revision N+1      (history never rewritten)
```
### QA state per variant revision (status is *derived*, not the last click)
```
 (none) ──Send to QA(rev R)──► Started
 Started ──QA: Send for Correction (≥1 open issue)──► Sent for Corrections
 Sent for Corrections ──Builder: save rev R2, Retest──► Retest   (submission points to R2, linked to original issues)
 Retest ──QA: issues resolved/ignored, Approve──► Approved (binds revision id + hash)
 Retest ──QA: issue still fails──► Sent for Corrections
 Started/Retest ──Approve (no open required issues)──► Approved
 Any state: new revision saved ⇒ does NOT change the submitted revision; the variant shows "newer revision exists"
```
Overall status = f(open issues, latest submission state, approval record). Approval of Revision 2 never applies to Revision 3.

### Issue
```
 Open ──Send for Correction──► Sent for Correction ──Builder Retest──► Retest ──pass──► Resolved
 Open/Retest ──Ignore (reviewer, reason, scope)──► Ignored ──(suppression revoked)──► Open
```

---

## 7. QA design notes
- Deterministic checks (HTML structure, links, images/alt, missing variables, rules lint, responsive overflow via Playwright, accessibility basics, localization completeness) and **AI suggestions** are separate runs, separate labels, and AI findings never block approval on their own.
- Issue **fingerprint** = hash(check id + block id/path + normalized evidence), so ignoring one defect cannot hide a different one.
- **Suppression**: default scope = this check + fingerprint in this project. Global suppression is a separate capability, requires a reason, is listed in App Settings, can be revoked, and every create/revoke is an audit event.
- **Approver ≠ author** enforced in the service and by a database check (Admin included), as in the existing project rules.
- "Browser preview is not an email-client test": the QA screen states what is not covered.

---

## 8. Implementation phases (relative complexity: S < M < L < XL)

| Phase | Scope | Complexity | Notes |
|---|---|---|---|
| B1 | Language registry, `all languages`, email variants, cloning, Segments tab (panels A/B), migration + backfill | **L** | Highest risk: data model change; flag + backup |
| B2 | Rules engine module (NOT, hide, lint), server-side derived segments + test audiences, Emails rule UI, Audiences tab | **L** | Replaces `derivedSync`, mapping, `removed` |
| B3 | Preview (two selectors + "why"), per-variant revisions, Versions chips/compare, Send to QA selector | **M** | Revisions become per variant |
| B4 | QA runs, issues, corrections, Builder to Check, approvals, suppression, audit; AI QA behind a switch | **XL** | Pulls M5/M6 forward; AI part needs your approval (Q6) |
| B5 | Design system (Inter, tokens, states, reduced motion), apply to 7 tabs + App Settings | **L** | Replaces Coral Night (Q9) |
| C | Validation scenario English+Arabic+German, UAE/VIP, screenshots, migration notes | **M** | |

Each phase ends with unit + browser tests green before the next, and `PROJECT_PLAN.md` / `PROJECT_STATUS.md` updated. M7 sending must later send **one approved revision per language**; a project is "ready to send" when every enabled language has an approved revision.

---

## 9. Assumptions and decisions needing your confirmation

**Must answer before Phase B**
1. **Features built in the last weeks that the brief does not mention.** The brief has no "separate copy per segment" mode, no contact-list segments chosen by up to 10 fields, no "send one segment another's email" mapping, and no Versions overview of segments. Recommendation: remove them from the main screens, keep their data read-only as "Legacy versions", and drop the code in a later cleanup. Confirm, or name what to keep.
2. **"Default email" vs "English-Email".** Yesterday you asked for the "Default email" name back. The brief makes English-Email the master. Recommendation: the English-Email *is* the default; it is what any contact with no matching language email receives. Confirm.
3. **Cloned emails are independent** (rule edits in English do not propagate). Do you want an explicit "re-copy rules from English" action? Recommendation: yes, optional and confirmed.
4. **Languages.** The list has **25** entries, not 26 (I count: English, Arabic, Danish, Dutch, Greek, Russian, Polish, French, German, Turkish, European Portuguese, Brazilian Portuguese, Taiwanese, Thai, Japanese, Korean, Simplified Chinese, Traditional Chinese, Bahasa, Hungarian, Norwegian, Spanish, Czech, Vietnamese, Swedish). I will not add a 26th. Which is missing? (Italian is a common one that is absent.)
5. **Taiwanese vs Traditional Chinese**: both use traditional characters. Proposal: keep two entries (`zh-TW`, `zh-Hant`) but warn when both are selected; or merge into one. **Bahasa**: Indonesian (`id`) or Malay (`ms`)? Proposal: `id-ID` unless you say Malay. **Norwegian**: Bokmål (`nb-NO`)?
6. **AI QA is a new third-party data flow.** It would send email content to an AI provider from the server (key stays server-side, never committed), costs money per run (up to 25 languages), and is non-deterministic. Approve adding it (which provider, monthly budget)? Recommendation: ship deterministic QA first, AI behind a setting.
7. **Global suppression scope.** Brief lets a QA reviewer create it. Recommendation: reviewers may create global rules only with a new capability, always with reason, Admin can revoke any, all audited; default scope is per project. Confirm.
8. **Terminology**: keep "Campaign" or rename to "Project" in the interface?
9. **Visual redesign** replaces Coral Night (plum + coral, dark mode, chosen 2026-10-17) with neutral + one accent and Inter. Confirm the accent colour (keep coral?), whether dark mode stays, and that Inter is self-hosted (no external font request).

**Gaps in the brief that I will otherwise decide as below**
- **Arabic is right-to-left.** The brief does not mention RTL; email templates, preview and screenshots need `dir=rtl` support. Added to B1 (M-sized extra). Thai/CJK need fonts in the screenshot browser.
- Scenario cap 60 per language; hard limit shown to the user.
- A rule stored inside a block can use any contact field (country, city, VIP, custom), as today.
- "Save revision" stays explicit (autosave keeps the draft); QA only ever receives saved revisions.
- Contact limit (10, Admin-raised) and "test sends only to allowlisted testers" are unchanged: test audiences are not contacts and are never emailed.
- 25 variants × QA runs is the scale target; no performance risk expected at this size.

**Risks I want you to know**
- B1 changes the core data model; it is the point of no easy return, hence flag + backup + read-only legacy tables.
- The test suite (213 unit, 5 browser suites) tests the current screens; much of the browser suite will be rewritten, not just updated.
- Pull-forward of QA (M5/M6) delays sending (M7) accordingly.

**Next step:** answer 1-9 (or say "use your recommendations"), approve Phase A, and I will start B1. Until then I change nothing.

---

## 10. Decisions recorded (2026-10-28)
1. Legacy per-segment copies, mapping and contact-field segments: removed from the main screens, data kept read-only as "Legacy versions". **Agreed.**
2. English-Email is the Default; it is what a contact with no matching language email receives. **Agreed.**
3. Cloning copies all rules of the source email (new ids, same behavior). Rules set in the English email are copied to every duplicated email by default. (Optional "re-copy rules from English" later: not decided.)
4. Language registry has **26** entries: the 25 supplied plus **Italian**.
5. Kept as separate entries: Taiwanese, Traditional Chinese, Norwegian (nb-NO), Bahasa (id-ID).
6. AI QA: question open, explained in chat (what is sent, cost, switch).
7. Global suppression: separate capability, reason required, Admin can revoke, all audited, per-project by default. **Agreed.**
8. Product renamed **Email Lego**; "Campaign" becomes "Email" in the interface. Open: naming of the per-language emails (see chat).
9. Visual direction: both options shown in the preview page; owner to choose.

## 11. Decisions recorded (2026-10-28, second round)
- The tab stays **Emails** (items inside: "English-Email"...). Interface wording: "Campaign" becomes "Email", product name "Email Lego".
- Visual direction: **keep Coral Night** (plum bar, coral, pill buttons, dark mode). Phase B5 becomes a consistency pass (spacing, focus/hover/disabled states, status indicators, reduced motion, responsive) on Coral Night, not a new identity. Font stays the system font unless the owner asks for Inter.
- AI QA: no paid AI API account. Options given in chat: (1) deterministic checks incl. offline language detection, (2) a small MCP server run on the owner's machine that lets Claude read a submitted revision and post findings back (scoped token, findings labelled AI suggestion), (3) export/import of a QA bundle, (4) a local open model, (5) free hosted tiers (not recommended for unsent content). Recommendation: ship (1) in B4, add (2)/(3) later. Awaiting the owner's choice.
- AI QA decision (2026-10-28): **option 1 for now** (deterministic checks incl. offline language detection). No AI service, no MCP, no key. A clearly separated place for AI suggestions is left in the QA design for later.

## 12. Status
Phase A open questions are all answered. Waiting for the owner's explicit approval to start Phase B1 (language registry with 26 languages, email variants and cloning, Segments tab panels A and B, migration with backup). No code has been changed.
