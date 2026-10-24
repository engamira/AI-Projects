# CLAUDE.md — working rules

- Source of truth: PROJECT_PLAN.md. Track progress in PROJECT_STATUS.md; update it after every milestone.
- Implement one milestone at a time. Run tests/checks before declaring done; report what changed, what was verified, what remains.
- Never claim a check passed without running it. Report failures plainly.
- Roles are permission-based (Admin, Builder, QA reviewer). Enforce on the server, never only in the UI.
- Library blocks are immutable; dropped blocks are independent copies. Never write edits back to definitions.
- Approval binds to a revision hash; any content edit invalidates it. Approver must differ from content author, Admin included.
- Report "delivered" only from a signed provider webhook. Distinguish accepted/delivered/bounced/failed.
- Secrets stay server-side; never commit .env or keys. Mock email adapter is test-only.
- Browser previews are not email-client tests; never claim QA catches all bugs.
- Check licenses before reusing third-party HTML/assets; prefer original designs.
- Contact limit is a setting: 10 while testing; only an Admin can raise it (ceiling 1000 for now), and the database enforces it. Test sends only to allowlisted testers.
- You may suggest extra features (benefit, effort, scope impact) but ask before implementing; keep working on agreed scope.
- Keep explanations concise; label assumptions.
