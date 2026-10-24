# PROJECT PLAN — Campaign LEGO (email campaign app)

Status of this document: consolidated v1 specification, last updated 2026-10-24 (M0-M3 complete; M4 in progress). Supersedes the earlier brief (simulated sending, local-only, SQLite, Editor/Sender roles).
Prices are approximate and must be re-verified at signup. Progress, checks and blockers live in PROJECT_STATUS.md.

## 1. Goal
Non-technical marketers build an email from drag-and-drop blocks, preview it, run QA, submit it for independent review, segment an audience, and send real emails through one provider. Hosted online with secure sign-in.

## 2. Decisions
| Area | Decision |
|---|---|
| Hosting | Render web service (Docker, Playwright base image), 512 MB plan. M0 measured Chromium screenshot at ~145 MB process memory and MJML rendering peaks ~190 MB, so no upgrade needed; re-check under QA load in M5 (fallback: 2 GB plan). |
| Environments | Two separate Neon databases: the live app uses the production one (configured only in Render); local development and tests use a separate dev database (`.env`). Automated tests run in throwaway schemas. |
| Migrations | SQL files applied automatically at server start, under a database advisory lock, so several instances can start together safely. |
| App look and feel | **Coral Night** (chosen 2026-10-17): plum top bar, coral accent and pill-shaped buttons, rounded cards, with a matching dark mode that follows the device setting. Applies to the app's own screens, not to the emails. |
| Database | Neon Postgres (replaces SQLite). Nightly pg_dump to R2. |
| Assets / screenshots | Cloudflare R2 |
| Email provider | Resend (server-side API, idempotency keys, signed webhooks). Mock adapter for tests only. |
| Domain | User buys a cheap, reputable domain (~$10-12/yr; avoid spam-prone cheap TLDs). Send from a subdomain, e.g. mail.<domain>. SPF/DKIM/DMARC configured in M7. Until then, sends only to the owner's own address. |
| Footer address | Dubai Silicon Oasis - pineapple tower G101 - Dubai - United Arab Emirates |
| Frontend | React, TypeScript, Vite, dnd-kit, Zustand + immer patches (undo/redo), TanStack Query |
| Backend | Node 24 LTS, Fastify, Zod, plain SQL migrations + typed `pg` queries (Drizzle ORM deferred: it added nothing for M0-M1; revisit if queries get complex), pg-boss (Postgres job queue, from M7) |
| Auth details (M1) | Argon2id passwords (12+ chars, lockout 5 failures/15 min); TOTP 2FA required for all users (authenticator app, 10 single-use recovery codes, codes cannot be replayed); sessions: random token stored hashed, httpOnly cookie, 2 h idle / 12 h absolute, new token after 2FA; CSRF token + origin check on all state-changing calls; every /api route must declare an access level (deny by default); TOTP secrets encrypted with APP_SECRET_KEY (AES-256-GCM); activity log is append-only (database trigger). Invitations are one-time 72 h links shown to the Admin (no email sending until Resend in M7). |
| Email rendering | MJML server-side; sanitize-html for custom HTML; Papa Parse for CSV |
| QA browser | Playwright (screenshots, overflow/clipping). Not real email-client testing. |
| Auth | Invite-only email+password (Argon2), server sessions in Postgres, httpOnly/Secure/SameSite cookies, CSRF protection, rate limiting. No public signup. |
| Tenancy | workspace_id on every table; repository layer requires workspace context; one workspace now. |
| Tests | Vitest, Playwright Test, real Postgres for concurrency tests |
| Dev tools (not app deps) | Claude Code, VS Code, Git; optional Playwright MCP. No MCP mandatory. |

Expected cost: ~$8-26/month + domain; Neon/R2/Resend within free tiers at this volume.

## 3. Roles and permissions (permission-based, not hard-coded names)
Roles: Admin, Builder, QA reviewer. Admin can create more users.

| Capability | Admin | Builder | QA reviewer |
|---|---|---|---|
| Create/edit campaigns, run automated checks, preview | custom HTML only | yes | no |
| Test send to designated testers | yes | yes | no |
| Submit for QA (assigned reviewer required, optional handover notes) | no | yes | no |
| Start review, record findings, request changes, retest, approve | no | no | yes |
| Ignore finding (reason + scope: occurrence or campaign) | no | no | yes |
| Send approved campaign to selected eligible audience | yes | yes | no |
| Manage users, testers, brand, rules, brand-scope exceptions, disable rules | yes | no | no |

Hard rules (server-enforced):
- Approver must differ from the author of the approved revision. Admin cannot bypass. An Admin who edits content (e.g. custom HTML) cannot approve it.
- QA never edits campaign content. Builder cannot approve or clear their own findings.
- Sending requires: current revision Approved, no unresolved blocking findings, eligibility rechecked at send time. Builder/Admin may send because approval comes from a different person.

## 4. Campaign workflow (separate from issue statuses)
Draft -> Submitted for QA -> Under review -> Changes requested -> Resubmitted for retest -> Approved -> Sent. QA may approve directly from Under review.
- Submit for QA requires: assigned QA reviewer; automated checks run on current revision; **Builder has viewed desktop and mobile preview of the current revision** (confirmation stored against the revision; any edit invalidates it).
- Editing during Submitted/Under review/Approved creates a new revision, voids approval, returns to Draft; reviewer notified and kept as default assignee. Prior findings carry forward as Retest required.
- Sent is set when the send job is created; later edits start a new Draft revision.
- Terminology: "campaign revision" = editing history; "audience variant" = recipient-specific content (future).
- Notifications: in-app only (bell + My QA Tasks: assigned campaigns, status, submission date, Builder).
- All assignments, submissions, reviews, approvals, and sends go to the activity history.

## 5. QA
Issue statuses: Open, Under review, Retest required, Resolved, Ignored. Fix proposed -> Retest required; pass -> Resolved; fail -> Open. Ignored requires reason + scope. Manual-only checks need recorded reviewer verification (reviewer, timestamp, reason, revision).
Each finding records: rule ID, severity, revision, affected block, description, evidence, suggested action, status, retest history.
Initial checks: missing subject/sender/preheader; empty buttons/missing links; malformed URLs; link/image checks (passed / failed / unable to verify); missing alt text; unresolved personalization; missing footer/unsubscribe; required tracking params (when enabled); disallowed domains; horizontal overflow/clipping. Screenshots with highlighted areas for visual findings; URLs/values/markup for others. Link checker is SSRF-protected. Never claim all email bugs are detectable.
Exceptions: ignore once; scoped (block, campaign, brand); admin-only rule disabling. Visible, reversible, recorded. "Teach the tool" = saved rules/exceptions, not model training.

## 6. Editor and content
- Library blocks are immutable, versioned originals. Dropping creates an independent instance (full props copy + sourceDefinitionId/version). Edits never alter library or other emails.
- Shared blocks: header/logo, hero, text, image, button, two-column, divider, spacer, social, footer. Specialty: travel (destinations, fares, offers, booking CTA); events (date/location, agenda, speakers, registration CTA); cosmetics (products, benefits, offers, shopping CTA).
- Drag, reorder, duplicate, delete, undo/redo, autosave, campaign duplication, revision restore (restore creates a new revision). (Built in M2.)
- **Link alias (built 2026-10-17):** every link field in every block has an alias field directly under it: an internal name (e.g. "Hero button") that recipients never see and that is not written into the email HTML; used by QA messages and click reports. Optional, so older emails still open. Blocks with links are library version 2.
- **Specialty blocks (M3), built as original blocks following the chosen layouts:** travel (racoon layout): destination cards, fares table, travel offer banner, booking button. Events (christmas layout): date and location banner, agenda list, speaker cards, registration button. Cosmetics (sphero-mini layout): product cards, benefits strip, promotional offer band, shopping button. Each is editable per email, has link aliases, and never alters the library original.
- **Locked template colors (built 2026-10-18, user decision):** no block and no email setting has any color control. Each campaign has a template palette chosen when it is created (Travel, Events or Cosmetics) and locked afterwards (the server refuses changes); every block, button, header and footer takes its colors from that palette. Palettes use only the colors of the reference designs (travel: orange `#fa8739` + charcoal `#2f323b`; events: dark slate `#354552` + neutrals; cosmetics: pink `#ff3fb4` / button pink `#d6247f`, sky blue `#00a3d9`, orange strip `#f15822`), with text/button colors adjusted where needed so every pairing meets WCAG AA contrast (checked by automated test). Header and footer colors follow the campaign's template, not the logo. Older saved emails are cleaned on open (old color properties dropped, missing palette becomes Travel). Block library versions: header/hero/image/button/two columns/social/footer 3, text/divider 2. A future "style variants" option (e.g. choosing a band style among the template's own colors) would need the user's approval.
- **Shared brand header and footer, one per template (M3, user decisions 2026-10-17 and 2026-10-18):** the Travel, Events and Cosmetics templates each have their own logo and their own shared header and footer, defined in Brand settings (Admin, `brand.manage`): logo, brand name, links, social links, postal address, unsubscribe wording. A campaign uses the header and footer of its template; colors come from the template palette. Logo files are supplied as references/logos/travel-logo.png, events-logo.png and cosmetics-logo.png (kept out of the repository) and are uploaded to the asset library. Every campaign shows them in place; Builders cannot edit them inside a campaign. Rules that keep review meaningful: (1) drafts follow the latest brand header/footer; (2) every revision that is submitted, approved or sent stores the exact resolved header/footer it used, so history is never rewritten; (3) if the brand header/footer changes while a campaign is approved but not sent, the approval is cancelled and it needs re-review, as with any content edit; (4) each brand change is versioned and recorded in the activity history; (5) the unsubscribe link and postal address live in the shared footer so they cannot be removed from one email. The rest of the library keeps the independent-instance rule.
- **Preview layout (M3, chosen "A+C" 2026-10-17):** (A) a "Live preview" toggle shows the canvas and a phone-width real-HTML preview side by side (phone/desktop switch; block list collapses to icons; preview refreshes about a second after the last edit, from the saved draft); (C) a full-screen preview shows phone and desktop side by side, width selector (320-1024), pop-out to a second window, "Preview as..." recipient picker (M3). Before Submit for QA (M6) this full-screen view opens as a required step and the Builder confirms it for that exact revision; QA findings are highlighted on the same view (M5).
- Brand settings, asset library, personalization with mandatory fallbacks (`{{first_name | fallback: "there"}}`), unresolved placeholder flagging, plain-text alternative.
- Preview: desktop/mobile selectable widths, labeled "browser preview, not Outlook/Gmail simulation", with selected recipient.
- Custom HTML: Admin only; sanitized allowlist, validated, previewed in sandboxed iframe with CSP.
- Same revision used for preview, QA, and sending (content hash).

## 7. Templates and references
- Reference links supplied (Framer *website* templates, not email; licenses not stated): godly.design Orchid (cosmetics), Aveon (events), Graft (travel). Only palette mood, whitespace, type scale may inform design; parallax/video/animation not feasible in email. No code/assets imported.
- User-chosen layout references (MJML gallery, mjml.io/try-it-live/templates): **cosmetics = sphero-mini**, **events = christmas**, **travel = racoon**. Checked 2026-10-15: none states a license; mjmlio/email-templates repo shows no visible LICENSE; sphero-mini contains a real brand's logos/content; christmas images are hosted on mailjet.com. Treat as all-rights-reserved: use as layout inspiration only, do NOT copy MJML markup, text, logos or images. Rebuild original blocks and content. Optionally ask MJML for written permission.
- Layout mapping (content differs from the verticals, so we adapt the pattern): racoon (apparel promo: header+menu, hero offer, free-shipping banner, product card grid, feature bands, icon info strip, footer) -> travel destinations/fares/offers/booking CTA. christmas (header, banner, centered title, alternating image/text rows, CTA, footer) -> events agenda/speakers/registration CTA. sphero-mini (colored bands, split text/image sections, mirrored product rows, bottom bar) -> cosmetics products/benefits/offers/shopping CTA.
- Other structure references (license UNVERIFIED; check before any reuse): Cerberus, Foundation for Emails, Maizzle starters. Inspiration-only galleries: Really Good Emails, Milled.
- Visual design is original; placeholder or licensed-free imagery. Final designs require user approval before M3 completes.

## 8. Audience
- Contact limit is a setting (user decision 2026-10-24): 10 while the functions are being tested, raised by an Admin (ceiling 1000 for now) when the real audience arrives; enforced across repeated imports and in the database. CSV import with field mapping, validation, clear row errors. Contacts have built-in fields plus custom fields (up to 20) created by hand or from unmatched CSV columns. **Segments (user decision 2026-10-24):** a campaign chooses one or more fields (for example Country + Language, or Language + City) and the audience is split into segments, one per combination of values, with total and eligible counts; each campaign may choose different fields; the segments chosen are shown when testing the email ("Preview as..." and test sends).
- **Campaign audience set-up and test audience (user decision 2026-10-25):** when setting up a campaign the Builder chooses its segmentation fields (Audience tab of the editor; draft only; changing them removes the old test audience). Each segment gets a short name made from its values in the order chosen, for example UAE-en, EG-ar, UAE-ar. These names appear in "Preview as..." (grouped: built-in examples, the campaign's test audience, and real contacts grouped by segment) and in test sends (M7). **Test audience:** the tool can generate made-up contacts to test the email against, one per segment: either one for each segment that exists in the contact list, or every combination of the values (from the list plus extra values typed in), at most 60. Test contacts live in their own table, never in the real contact list or its limit, use addresses ending in `.invalid` (enforced by the database, so they can never be real mailboxes), cannot be selected as send recipients, and are shown to QA reviewers as part of the campaign; real contacts are visible in "Preview as..." only to people with audience access. Personalization placeholders can use any contact field (built-in or your own), e.g. `{{country | fallback: "your country"}}`. Audience variants (different content per segment) remain a future item.
- Duplicates: key = trimmed lowercase email. Within file: first kept, later rows skipped and reported. Against stored: skipped by default, per-import option to update attributes (does not consume capacity). Over-cap imports show a preview of rows that fit; nothing saved until confirmed.
- Visual AND/OR filters with type-appropriate operators, missing-value handling, saved segments, match counts, sample records.
- Eligible = filter match minus inactive marketing permission, unsubscribed, suppressed. Show match count and eligible count separately. Bounce/complaint webhooks add suppression.
- Real recipient emails (owned/consenting); other attributes dummy. Select individuals or full eligible audience; exact recipients and count shown before sending.
- Sample data demonstrates filtering, exclusions, fallbacks.

## 9. Sending
- Test send (allowlisted designated testers) and campaign send. Unsubscribe: signed one-click link + List-Unsubscribe headers + public page; footer includes postal address.
- Duplicate prevention: unique (send_job_id, contact_id) claimed in a transaction before API call; provider idempotency key jobId:contactId; webhook events deduplicated by event ID.
- Statuses: queued, accepted by provider, delivered, bounced, failed (+ delayed/complaint events). "Delivered" only after signed provider webhook.
- Records: revision, audience snapshot, provider message IDs, outcomes. DeliveryProvider interface (send, verifyWebhook, parseEvents); Resend adapter only; mock adapter loads only under NODE_ENV=test. Credentials server-side only.

## 10. Entities
workspace, user, session, notification, brand_settings, asset, block_definition, campaign, campaign_revision, preview_confirmation, qa_run, qa_finding, finding_event, qa_rule, qa_exception, qa_submission (assignment, notes), approval, contact, import_batch, segment, tester_allowlist, send_job, send_recipient, provider_event, activity_log (append-only).

## 11. Milestones and acceptance
- **M0 Foundations/hosting (COMPLETE 2026-10-15):** accounts, deployed skeleton, CI, migrations, Chromium memory measured. Accept: HTTPS page loads; /health checks DB; Playwright screenshot works on host; row survives restart and redeploy.
- **M1 Auth/roles/notifications (COMPLETE 2026-10-17):** three roles, capability model, Admin user creation, in-app notifications, TOTP two-factor sign-in with recovery codes. Accept: permission-matrix test over every endpoint x role passes (incl. Admin-bypass attempts); sessions expire; rate limiting works; sign-in is refused without a valid second factor; recovery code works once and Admin can reset a user's 2FA (logged).
- **M2 Editor core (COMPLETE 2026-10-17; user hosted Builder walkthrough pending):** block model, shared blocks, MJML render, DnD, undo/redo, autosave, duplication, revisions. Accept: instance edits persist across reload; library and other emails byte-identical; restore works; render stable.
- **M3 Templates/assets/brand/preview (COMPLETE 2026-10-24; user approved the three starter layouts; see PROJECT_STATUS.md for what was built and what moved):** the three starter templates with their specialty blocks (see section 6); shared brand header/footer with Brand settings and versioning; R2 asset library (logo and images); live preview and full-screen preview with "Preview as..." recipient; personalization with mandatory fallbacks and unresolved-placeholder flagging; plain-text alternative; sanitized custom HTML for Admins; Coral Night theme already applied. Needs from user: brand name/logo/social links/colors, Cloudflare R2 bucket and key, approval of template looks (screenshots shown before sign-off). Accept: all three templates build and preview; specialty blocks are independent per email and never change library originals; changing the brand header/footer updates drafts, leaves approved/sent revisions untouched and cancels approval of unsent approved campaigns; live and full-screen preview work at selectable widths with labels; placeholders flagged; plain text generated; XSS suite passes.
- **M4 Audience (IN PROGRESS):** import, custom fields, segmentation by chosen fields, segment names, test audience, counts (AND/OR filters and saved segments are optional and to be offered separately). Accept: cap holds across imports; row-level errors; operators tested; counts shown separately; sample data covers exclusions.
- **M5 QA engine:** all initial checks, evidence, screenshots, manual-check labelling. Accept: planted defect per rule detected and classified correctly.
- **M6 Submit/review/approval:** Submit for QA with preview gate, My QA Tasks, review actions, exceptions, approval. Accept: all transitions tested; self-approval blocked incl. Admin; edit voids approval; submission blocked without current preview; everything logged.
- **M7 Real sending:** domain/DNS, Resend adapter, webhooks, allowlist test send, recipient review screen, campaign send by Admin/Builder. Accept: real emails reach chosen inboxes; unselected/ineligible get none; retries/parallel requests/crash create zero duplicates; delivered/bounced only from webhooks; replays ignored.
- **M8 Reports/backups/final:** reports separating send outcomes from QA, activity search, nightly backup + documented restore drill, migration/deploy docs, full hosted workflow. Accept: every v1 criterion verified on the hosted app and recorded in PROJECT_STATUS.md.

## 12. Testing strategy
Block isolation (mutate instance, assert definitions/other emails unchanged; restore; duplicate). QA state machine (every transition + exception scope). Audience filters (table-driven operators, nulls, nesting, count consistency). Roles (endpoint x role matrix via direct API). Duplicate sends (concurrent requests, crash-retry, repeated webhooks on real Postgres; one real-inbox smoke test on hosted app). Approval invalidation after any edit.

## 13. Scope
Current: everything above. Future: dynamic audience variants (recommend combination of conditional blocks + full variants; ordered first-match priority, default variant, one variant per recipient, QA/approval per variant, final summary of segments/variants/unique recipients; present options and examples before building), AI-assisted review, real client rendering, other providers/SFMC, multiple workspaces, email notifications, A/B tests.
Approved and built suggestions: two-factor sign-in (TOTP authenticator app, recovery codes; required for all users; M1) and Sentry error monitoring (M0; error reports exclude user, cookies, headers and request bodies).

## 14. Local setup
Node 24 LTS, Git, VS Code; npm install; npx playwright install chromium; copy .env.example to .env (Neon DEV database, APP_SECRET_KEY, APP_BASE_URL, later R2/Resend keys; never the production database); npm run dev; npm test; npm run e2e (browser tests). Accounts: GitHub, Render, Neon, Cloudflare, Resend, domain registrar.
