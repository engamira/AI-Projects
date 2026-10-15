# PROJECT STATUS

Last updated: 2026-10-15

## Current milestone: M0 Foundations/hosting — COMPLETE except CI (needs GitHub `workflow` scope)
- Sentry verified 2026-10-16: deliberate test error reached the `campaign-lego` project (user confirmed). Event-detail privacy (no body/headers/cookies/user) not yet inspected by user. Test endpoint removed afterwards.
- Bug found and fixed during the check: error handler turned 4xx client errors into 500s and reported them; now 4xx keep their status and are not sent to Sentry.
- Remaining: move ci/github-ci.yml to .github/workflows/ci.yml after `gh auth refresh -s workflow`.

## Completed
- Plan, CLAUDE.md, status files.
- Node 24 LTS present (v24.22). Note: not on the PATH of Claude's terminal; commands prepend `C:\Program Files\nodejs`, and git needs `C:\Program Files\Git\cmd`.
- Monorepo (`packages/shared|server|web`), git repo initialised (no commits yet).
- Server: Fastify `/health` (reports database ok/error/not_configured), token-protected M0 endpoints (`/api/m0/probe` GET/POST, `/api/m0/screenshot`; disabled unless `M0_CHECK_TOKEN` set), SQL migration runner (`schema_migrations` table, transactional), Sentry with user info/cookies/headers/bodies/query strings disabled.
- Web: Vite+React placeholder showing server status.
- Dockerfile (Playwright v1.64.1 image), render.yaml (plan: starter, preDeploy migration), GitHub Actions CI.
- Neon agent skills installed into `.claude/skills` (user-requested).

## Checks run
- `npm run build`, `npm run typecheck`: pass.
- `npm test`: 6/6 pass (health states, token protection).
- Local Chromium screenshot via Playwright: works (7 KB PNG, process RSS 124 MB, first launch 33 s incl. warm-up). Hosted memory NOT yet measured.
- Local against Neon (2026-10-15): migration 0001 applied; /health database ok; probe row inserted, server restarted, row still present; unauthenticated probe returns 401; built web app served (200).
- Code pushed to https://github.com/engamira/AI-Projects branch `main` (remote `master` with README untouched). CI workflow kept at ci/github-ci.yml because the stored GitHub login lacks `workflow` scope; move to .github/workflows/ci.yml after re-authorising.
- Hosted (https://ai-projects-9vgh.onrender.com, 2026-10-15): HTTPS 200; /health database ok; Playwright screenshot ok on current Render plan (4.2 s, process RSS ~145 MB; single run); probe rows 1-2 present after manual redeploy; probe endpoints 401 without token. Docker build succeeded on Render.
- NOT yet verified (superseded items above): Docker build (Docker not installed locally; will build on Render), HTTPS page, restart/redeploy persistence, Sentry event delivery.

## Blockers / needed from user
- User to create the Render web service from the GitHub repo (branch `main`, Docker) and enter DATABASE_URL, SENTRY_DSN, M0_CHECK_TOKEN there.
- Sentry event delivery not yet confirmed (DSN is in .env).
- Resend key pasted into chat on 2026-10-15 was revoked by the user. Not needed until M7.
- Domain purchase needed before M7. Cloudflare account exists (R2 needed from M3).
- Pending suggestion decision: none (Sentry and 2FA approved).

## M0 acceptance remaining
HTTPS page loads on Render; /health shows database ok; Playwright screenshot succeeds on the host (decide starter vs 2 GB plan from result); probe row survives restart and redeploy.

## Next
Finish M0 hosted checks, then M1 (auth, roles, TOTP 2FA, notifications).
