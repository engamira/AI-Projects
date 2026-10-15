# PROJECT PLAN — Campaign LEGO (email campaign app)

Status of this document: consolidated v1 specification. Supersedes the earlier brief (simulated sending, local-only, SQLite, Editor/Sender roles).
Prices are approximate and must be re-verified at signup.

## 1. Goal
Non-technical marketers build an email from drag-and-drop blocks, preview it, run QA, submit it for independent review, filter an audience of up to 10 contacts, and send real emails through one provider. Hosted online with secure sign-in.

## 2. Decisions
| Area | Decision |
|---|---|
| Hosting | Render web service (Docker, Playwright base image). Size (Starter ~$7 vs 2 GB ~$25) decided by measuring Chromium memory in M0. |
| Database | Neon Postgres (replaces SQLite). Nightly pg_dump to R2. |
| Assets / screenshots | Cloudflare R2 |
| Email provider | Resend (server-side API, idempotency keys, signed webhooks). Mock adapter for tests only. |
| Domain | User buys a cheap, reputable domain (~$10-12/yr; avoid spam-prone cheap TLDs). Send from a subdomain, e.g. mail.<domain>. SPF/DKIM/DMARC configured in M7. Until then, sends only to the owner's own address. |
| Footer address | Dubai Silicon Oasis - pineapple tower G101 - Dubai - United Arab Emirates |
| Frontend | React, TypeScript, Vite, dnd-kit, Zustand + immer patches (undo/redo), TanStack Query |
| Backend | Node 22, Fastify, Zod, Drizzle ORM + SQL migrations, pg-boss (Postgres job queue) |
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
- Drag, reorder, duplicate, delete, undo/redo, autosave, campaign duplication, revision restore (restore creates a new revision).
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
- Max 10 stored contacts, enforced across repeated imports. CSV import with field mapping, validation, clear row errors.
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
- **M0 Foundations/hosting:** accounts, deployed skeleton, CI, migrations, Chromium memory measured. Accept: HTTPS page loads; /health checks DB; Playwright screenshot works on host; row survives restart and redeploy.
- **M1 Auth/roles/notifications:** three roles, capability model, Admin user creation, in-app notifications, TOTP two-factor sign-in with recovery codes. Accept: permission-matrix test over every endpoint x role passes (incl. Admin-bypass attempts); sessions expire; rate limiting works; sign-in is refused without a valid second factor; recovery code works once and Admin can reset a user's 2FA (logged).
- **M2 Editor core:** block model, shared blocks, MJML render, DnD, undo/redo, autosave, duplication, revisions. Accept: instance edits persist across reload; library and other emails byte-identical; restore works; render stable.
- **M3 Templates/assets/brand/preview:** (after references approved) three templates + specialty blocks, R2 assets, brand, preview widths, recipient preview, personalization, plain text, sanitized custom HTML. Accept: all templates build and preview; labels present; placeholders flagged; XSS suite passes.
- **M4 Audience:** import, filters, segments, counts. Accept: cap holds across imports; row-level errors; operators tested; counts shown separately; sample data covers exclusions.
- **M5 QA engine:** all initial checks, evidence, screenshots, manual-check labelling. Accept: planted defect per rule detected and classified correctly.
- **M6 Submit/review/approval:** Submit for QA with preview gate, My QA Tasks, review actions, exceptions, approval. Accept: all transitions tested; self-approval blocked incl. Admin; edit voids approval; submission blocked without current preview; everything logged.
- **M7 Real sending:** domain/DNS, Resend adapter, webhooks, allowlist test send, recipient review screen, campaign send by Admin/Builder. Accept: real emails reach chosen inboxes; unselected/ineligible get none; retries/parallel requests/crash create zero duplicates; delivered/bounced only from webhooks; replays ignored.
- **M8 Reports/backups/final:** reports separating send outcomes from QA, activity search, nightly backup + documented restore drill, migration/deploy docs, full hosted workflow. Accept: every v1 criterion verified on the hosted app and recorded in PROJECT_STATUS.md.

## 12. Testing strategy
Block isolation (mutate instance, assert definitions/other emails unchanged; restore; duplicate). QA state machine (every transition + exception scope). Audience filters (table-driven operators, nulls, nesting, count consistency). Roles (endpoint x role matrix via direct API). Duplicate sends (concurrent requests, crash-retry, repeated webhooks on real Postgres; one real-inbox smoke test on hosted app). Approval invalidation after any edit.

## 13. Scope
Current: everything above. Future: dynamic audience variants (recommend combination of conditional blocks + full variants; ordered first-match priority, default variant, one variant per recipient, QA/approval per variant, final summary of segments/variants/unique recipients; present options and examples before building), AI-assisted review, real client rendering, other providers/SFMC, multiple workspaces, email notifications, A/B tests.
Approved suggestion: two-factor sign-in (TOTP authenticator app, recovery codes; required for all users; built in M1). Pending suggestion: Sentry error monitoring.

## 14. Local setup
Node 22 LTS, Git, VS Code; npm install; npx playwright install chromium; copy .env.example to .env (Neon dev DB, R2, Resend keys); npm run dev; npm test. Accounts: GitHub, Render, Neon, Cloudflare, Resend, domain registrar.
