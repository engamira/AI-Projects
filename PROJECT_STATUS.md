# PROJECT STATUS

Last updated: 2026-10-15

## Current milestone: M0 Foundations/hosting — IN PROGRESS (local part done, hosted part blocked on accounts)

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
- NOT yet verified: database connection/migration against Neon, Docker build (Docker not installed locally; will build on Render), HTTPS page, restart/redeploy persistence, Sentry event delivery.

## Blockers / needed from user
- Neon database connection string -> local `.env` as DATABASE_URL (user pastes it only in .env).
- Sentry DSN (project `campaign-lego` in org `amira-soudy`) -> `.env` / Render. Unknown what "run code ec18af2a73" is for.
- GitHub repo URL so code can be pushed and Render can deploy.
- SECURITY: a Resend API key was pasted into chat on 2026-10-15; user told to revoke and recreate it. Not saved anywhere. Not needed until M7.
- Domain purchase needed before M7. Cloudflare account exists (R2 needed from M3).
- Pending suggestion decision: none (Sentry and 2FA approved).

## M0 acceptance remaining
HTTPS page loads on Render; /health shows database ok; Playwright screenshot succeeds on the host (decide starter vs 2 GB plan from result); probe row survives restart and redeploy.

## Next
Finish M0 hosted checks, then M1 (auth, roles, TOTP 2FA, notifications).
