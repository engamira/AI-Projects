# PROJECT STATUS

Last updated: 2026-10-16

## Milestones
- **M0 Foundations/hosting: COMPLETE** (2026-10-15). Hosted at https://ai-projects-9vgh.onrender.com (Render, Neon Postgres). Verified: HTTPS, /health, Playwright screenshot on host, data survives redeploy, Sentry receives errors with no body/headers/cookies/user, GitHub Actions CI.
- **M1 Auth, roles, 2FA, notifications: COMPLETE** (user confirmed 2026-10-17 that the first Admin set a password, enrolled a real authenticator app and signed in on the hosted app; not independently observable by Claude). Builder and QA reviewer accounts still to be created by the Admin.
- (Earlier note) Deployed state: Deployed 2026-10-17: hosted /health ok and /api/auth/me answers `{"stage":"none"}` (new code live). CI green on GitHub (build, typecheck, 40 tests against a Postgres service, 11 browser checks on Linux). Remaining: user creates the first Admin with `create-admin`, signs in, scans the QR with a real authenticator app, saves recovery codes.

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
Deploy M1 and verify hosted; then M2 Editor core (block model, MJML render, drag-and-drop, undo/redo, autosave, revisions).
