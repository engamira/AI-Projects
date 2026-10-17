# PROJECT STATUS

Last updated: 2026-10-16

## Milestones
- **M0 Foundations/hosting: COMPLETE** (2026-10-15). Hosted at https://ai-projects-9vgh.onrender.com (Render, Neon Postgres). Verified: HTTPS, /health, Playwright screenshot on host, data survives redeploy, Sentry receives errors with no body/headers/cookies/user, GitHub Actions CI.
- **M1 Auth, roles, 2FA, notifications: COMPLETE** (user confirmed 2026-10-17 that the first Admin set a password, enrolled a real authenticator app and signed in on the hosted app; not independently observable by Claude). Builder and QA reviewer accounts still to be created by the Admin.
- (Earlier note) Deployed state: Deployed 2026-10-17: hosted /health ok and /api/auth/me answers `{"stage":"none"}` (new code live). CI green on GitHub (build, typecheck, 40 tests against a Postgres service, 11 browser checks on Linux). Remaining: user creates the first Admin with `create-admin`, signs in, scans the QR with a real authenticator app, saves recovery codes.

- **M2 Editor core: DEPLOYED (2026-10-17), awaiting a Builder sign-in check on the hosted app.** Live: `/health` ok, `/api/library/blocks` answers 401 when signed out (route exists), CI green (build, typecheck, 60 tests, 24 browser checks on Linux). First deploy attempt was silently rejected by Render because migration 0003 had not been applied to the production database (the Render pre-deploy command had apparently never run; M1's tables were applied earlier by the create-admin command). Fixed: the server now applies pending migrations at startup under a database lock, and a new test (3 instances starting at once) caught and fixed a real race in creating the migrations table. Unknown routes under /api answer 403 `route_not_declared` (deny by default) rather than 404.

## M2 delivered
- **Block library:** 10 shared blocks (header/logo, hero banner, text, image, button, two columns, divider, spacer, social links, footer) stored as immutable, versioned originals in `block_definition` (database trigger blocks edits/deletes; the server refuses to start if a released version's definition changes). No API route can change them.
- **Independent instances:** dropping a block copies its defaults into the email as the email's own instance (own id, `sourceVersion`, full props). Edits are saved to that campaign only; duplicating a block or campaign creates new ids.
- **Editor:** drag from the library (or press Add), reorder by drag or arrow buttons, duplicate, delete, undo/redo (with typing merged into one step), autosave 1.2 s after the last change with visible status, simple controls for text, images (https address for now; asset library comes in M3), links, colors, spacing, email settings (subject, preheader, sender, width, font). Unsafe links/values are flagged inline and not saved. Warns before leaving with unsaved changes. Read-only view for Admin and QA reviewer.
- **Saving rules:** server validates every save (allowed block types and fields only; https/http/mailto/tel links or `{{placeholder}}`; hex colors; size limits; max 100 blocks). Optimistic concurrency: an older window cannot overwrite newer work (409 + "Reload latest").
- **Versions:** named versions, restore (recorded as a new version; history is immutable by database trigger), duplicate campaign (new block ids).
- **Preview:** real MJML-generated HTML in a fully sandboxed frame at selectable widths (320-1024 + custom), labeled "browser preview, not an Outlook or Gmail simulation". Same renderer will serve QA and sending. All text is HTML-escaped.
- New capability `campaign.view` (all roles). Campaign actions are logged in the activity history.

## M2 checks (2026-10-17)
- 59 server tests pass (19 new): library immutability, edits restored exactly on reopen, other emails/library unchanged, validation of dangerous content, conflicts, versions/restore, duplicate independence, role permissions, activity log, HTML escaping, placeholders preserved, deterministic output.
- 13 editor browser checks pass (Playwright): create, add by button and drag-and-drop, reorder by drag and arrows, duplicate/delete/undo/redo, edit text and colors, unsafe link blocked, reload restores edits, new email starts from original defaults, preview widths, save/restore a version, duplicate campaign independence, read-only roles, phone layout. 11 sign-in browser checks still pass.
- Bug found by the browser test and fixed: toolbar buttons re-selected the clicked block (after Duplicate the original stayed selected).
- NOT yet verified: hosted deployment of M2; behaviour on touch devices; keyboard-only drag in a real screen-reader session.
- Known limits (by design, later milestones): no starter templates or specialty blocks (M3), no asset library/uploads (M3), no personalization or plain-text yet (M3), no QA (M5).

## M1 delivered (code complete)
- Roles Admin / Builder / QA reviewer as capability bundles (`packages/shared`); server checks capabilities only. Builder and Admin can send an approved campaign (approval must come from a different person; enforced when campaigns exist in M6).
- Invite-only accounts; Admin creates users and gets a one-time 72 h link (no email yet). Password reset = new link. Admin can change role, disable/enable, reset 2FA, unlock. Cannot change own role or disable self.
- Sign-in: password (Argon2id, 12+ chars, lockout after 5 failures for 15 min) then mandatory authenticator-app 2FA (QR + manual key, 10 single-use recovery codes, no code replay). Session rotated after 2FA; 2 h idle / 12 h absolute expiry; hardened cookie; CSRF token + origin check; rate limiting; security headers.
- Every /api route declares its access level or is refused (deny by default).
- In-app notifications (bell) and append-only activity history (database trigger blocks edits/deletes); Admin Users and Activity pages; Account page (change password).
- `npm run create-admin -- <email> "<Name>"` creates the first Admin and prints a one-time link.
- M0 test endpoints removed (probe/screenshot); screenshot code returns in M5.

## Checks run (2026-10-16)
- Build, typecheck: pass.
- 40 automated tests pass against a throwaway schema in Neon: role definitions match the spec; every route declares access; role x route permission matrix including direct API calls; unauthenticated and half-signed-in sessions refused; login/lockout/2FA/recovery codes/replay; session expiry; CSRF/origin; password change; invitations (single use, expiry, reissue); user management safety rules; append-only log; notification isolation.
- Mutation check: deliberately granting QA reviewers `users.manage` made 2 tests fail, then reverted.
- 11 browser checks pass (Playwright, real built app): sign-in, wrong password message, 2FA, invitation, enrolment on a 390 px phone screen, recovery codes gate, Builder cannot open Users page, notification bell, activity history, sign-out, no horizontal overflow.
- NOT yet verified: hosted deployment of M1; first Admin created in the hosted database; CI run of the new Linux job (Postgres service + e2e); real authenticator app scan.

## Blockers / needed from user
1. Add to Render environment: `APP_SECRET_KEY` (copy the value from local `.env`; local and hosted share one database, so it must be identical) and `APP_BASE_URL=https://ai-projects-9vgh.onrender.com`. Optionally delete `M0_CHECK_TOKEN`. The server refuses to start without APP_SECRET_KEY, so deploy only after this.
2. After deploy, user runs `create-admin` locally (with `APP_BASE_URL` set to the hosted URL) so the one-time link never appears in chat.
3. Domain purchase before M7. Cloudflare R2 needed from M3.
- Local dev and hosted app currently share ONE Neon database (including real users). Recommend a separate Neon dev branch before M2; tests already use isolated throwaway schemas.

## Next
Verify M2 on the hosted app; then M3 Templates/assets/brand/preview (needs: user's Cloudflare R2 bucket + keys for the asset library, approval of the three template designs).
