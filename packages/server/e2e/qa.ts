// Browser test for QA: run checks, send a finding back, the builder fixes it and asks for a retest, QA approves that revision,
// and a finding is ignored for good (App Settings shows the rule and can revoke it).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { EmailContent } from '@cl/shared';
import { createTestApp } from '../src/testkit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.resolve(here, '../../../.env'));
} catch {
  /* CI provides DATABASE_URL */
}
const PORT = 3118;
const BASE = `http://127.0.0.1:${PORT}`;
const webDir = path.resolve(here, '../../web/dist');

const t = await createTestApp({ webDir });
let passed = 0;
const ok = (name: string) => { passed++; console.log(`PASS  ${name}`); };
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL  ${msg}`);
}

const browser = await chromium.launch();
try {
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const builderApi = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  const qaApi = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
  const open = async (client: typeof builderApi) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await ctx.addCookies([{ name: 'cl_session', value: client.sessionToken!, url: BASE }]);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
    p.on('dialog', (d) => void d.accept());
    return p;
  };
  void qaApi;

  // ---- an English email with a starter layout, saved and sent to QA by the builder (through the API: faster)
  const c = (await builderApi.post('/api/campaigns', { name: 'QA walk-through', palette: 'travel', starter: true, model: 'v2' })).body;
  await builderApi.put(`/api/campaigns/${c.id}/languages`, { input: 'English' });
  const en = (await builderApi.post(`/api/campaigns/${c.id}/emails`, { languageId: 'en', createFromId: null })).body;
  const blank = en.draft.content as EmailContent;
  blank.settings.subject = ''; // so the checks have something to find
  blank.settings.preheader = '';
  await builderApi.put(`/api/emails/${en.id}/draft`, { content: blank, baseVersion: en.draft.version });
  await builderApi.post(`/api/emails/${en.id}/revisions`, {});
  const sent = await builderApi.post(`/api/emails/${en.id}/qa-submissions`, {});
  assert(sent.status === 201 && sent.body.revisionNumber === 2, 'the builder sent the saved revision to QA');

  const qa = await open(qaApi);
  const builder = await open(builderApi);

  // ---- QA runs the checks
  await qa.goto(`${BASE}/campaigns/${c.id}?tab=qa`);
  await qa.getByTestId('qa-row').filter({ hasText: 'English-Email' }).getByText('Started').waitFor();
  await qa.getByRole('button', { name: 'Review English-Email' }).click();
  await qa.getByTestId('qa-review').waitFor();
  assert(await qa.getByRole('button', { name: /Approve revision 2/ }).isDisabled(), 'approval is not possible before the checks ran');
  await qa.getByRole('button', { name: 'Run QA checks' }).click();
  await qa.getByTestId('qa-message').filter({ hasText: 'QA checks finished.' }).waitFor();
  const subjectRow = qa.locator('[data-testid="issue-row"][data-check="settings.subject_missing"]');
  await subjectRow.waitFor();
  assert(/^QA-\d{4}/.test(await subjectRow.locator('td').first().innerText()), 'a finding has an ID like QA-0001');
  assert((await subjectRow.innerText()).includes('Automatic check'), 'the finding says it is an automatic check');
  await qa.getByText('What the checks covered').click();
  await qa.getByText(/Outlook, Gmail/).waitFor(); // it says what it cannot check
  ok('QA runs the checks on the submitted revision; findings have IDs, severity, evidence and a source; the limits are stated');

  // ---- send for correction, with a note
  await subjectRow.getByRole('textbox').fill('Please add the subject line.');
  await subjectRow.getByRole('button', { name: 'Send for Correction' }).click();
  await qa.getByTestId('qa-message').filter({ hasText: 'sent for correction' }).waitFor();
  await qa.getByTestId('qa-row').filter({ hasText: 'English-Email' }).getByText('Sent for Corrections').waitFor();
  ok('Send for Correction: the email status becomes Sent for Corrections');

  // ---- the builder sees it, cannot ignore it, cannot retest before saving a new revision
  await builder.goto(`${BASE}/campaigns/${c.id}?tab=check`);
  const card = builder.getByTestId('correction');
  await card.getByText('Please add the subject line.').waitFor();
  await card.getByText('The subject line is empty').first().waitFor();
  assert(await card.getByRole('button', { name: /^Ignore/ }).isDisabled(), 'a builder cannot ignore a finding');
  await card.getByRole('button', { name: /^Retest/ }).click();
  await builder.getByText(/Save a new revision with your corrections first/).waitFor();
  ok('Builder to Check shows the finding with the QA note; Ignore is QA only; a retest needs a new saved revision');

  // ---- the builder fixes the subject in the Emails tab, saves a revision and asks for a retest
  await builder.goto(`${BASE}/campaigns/${c.id}?tab=emails&lang=en`);
  await builder.getByLabel('Subject line').fill('Autumn fares from Dubai');
  await builder.getByText('All changes saved').waitFor();
  await builder.getByRole('button', { name: 'Save revision' }).click();
  await builder.getByText('Saved as revision 3.').waitFor();
  await builder.goto(`${BASE}/campaigns/${c.id}?tab=check`);
  await builder.getByTestId('correction').getByRole('button', { name: /^Retest/ }).click();
  await builder.getByTestId('check-message').filter({ hasText: 'revision 3 was sent back to QA for a retest' }).waitFor();
  ok('after saving revision 3 the builder asks for a retest; it goes back to QA and is not approved');

  // ---- QA: the retest. The old finding is gone, the rest need a decision, then QA approves revision 2
  await qa.goto(`${BASE}/campaigns/${c.id}?tab=qa`);
  await qa.getByTestId('qa-row').filter({ hasText: 'English-Email' }).getByText('Retest').first().waitFor();
  await qa.getByRole('button', { name: 'Review English-Email' }).click();
  await qa.getByRole('heading', { name: /Revision 3/ }).waitFor();
  await qa.getByRole('button', { name: 'Run QA checks' }).click();
  await qa.getByTestId('qa-message').filter({ hasText: 'QA checks finished.' }).waitFor();
  assert((await qa.locator('[data-check="settings.subject_missing"]').count()) === 0, 'the subject finding is not in the retest');
  // ignore this kind of finding for this email for good (low risk), then deal with the blocking ones one by one
  const low = qa.locator('[data-testid="issue-row"][data-check="settings.preheader_missing"]');
  await low.getByRole('button', { name: 'Ignore…' }).click();
  await low.getByLabel(/Reason to ignore/).fill('We do not use preview text');
  await low.getByLabel(/Ignore scope for/).selectOption('project');
  await low.getByRole('checkbox').check();
  await low.getByRole('button', { name: 'Ignore', exact: true }).click();
  await qa.getByTestId('qa-message').filter({ hasText: 'ignored.' }).waitFor();
  for (let guard = 0; guard < 12; guard++) {
    const open = qa.locator('[data-testid="issue-row"]').filter({ hasText: /High|Critical/ }).filter({ has: qa.getByRole('button', { name: 'Ignore…' }) });
    if ((await open.count()) === 0) break;
    const row = open.first();
    await row.getByRole('button', { name: 'Ignore…' }).click();
    await row.getByLabel(/Reason to ignore/).fill('Checked by hand');
    await row.getByRole('button', { name: 'Ignore', exact: true }).click();
    await qa.getByTestId('qa-message').filter({ hasText: 'ignored.' }).waitFor();
  }
  await qa.getByRole('button', { name: 'Approve revision 3' }).click();
  await qa.getByTestId('qa-message').filter({ hasText: 'Revision 3 approved.' }).waitFor();
  await qa.getByTestId('qa-row').filter({ hasText: 'English-Email' }).getByText('Approved').waitFor();
  assert(await qa.getByRole('button', { name: 'Run QA checks' }).isDisabled(), 'an approved revision can no longer be re-checked');
  ok('QA retests revision 3, deals with the findings and approves exactly that revision');

  // ---- the builder sees the approval on the revision; an older revision is not approved
  await builder.goto(`${BASE}/campaigns/${c.id}?tab=versions&lang=en`);
  await builder.getByTestId('revision-row').filter({ hasText: 'Revision 3' }).getByText('Approved').waitFor();
  assert((await builder.getByTestId('revision-row').filter({ hasText: 'Revision 2' }).getByText('Approved').count()) === 0, 'revision 2 is not approved');
  ok('the approval applies to revision 3 only');

  // ---- App Settings: the rule made by "ignore this kind of finding" is listed and can be revoked
  await qa.goto(`${BASE}/settings`);
  const rule = qa.getByTestId('suppression-row').filter({ hasText: 'settings.preheader_missing' });
  await rule.waitFor();
  await rule.getByText('We do not use preview text').waitFor();
  await rule.getByLabel(/Reason to revoke/).fill('Preview text is wanted again');
  await rule.getByRole('button', { name: 'Revoke' }).click();
  await qa.getByTestId('suppression-row').filter({ hasText: 'Revoked by' }).waitFor();
  ok('App Settings lists the rule with its reason, and revoking it keeps a record');

  // ---- roles: a builder has no App Settings and no approve button
  await builder.goto(`${BASE}/`);
  assert((await builder.getByRole('link', { name: 'App Settings' }).count()) === 0, 'a builder does not see App Settings');
  await builder.goto(`${BASE}/campaigns/${c.id}?tab=qa`);
  await builder.getByTestId('qa-row').first().waitFor();
  assert((await builder.getByRole('button', { name: /^Approve/ }).count()) === 0, 'a builder has no Approve button');
  ok('a builder cannot approve or open App Settings');
  void (null as unknown as EmailContent);

  console.log(`\n${passed} QA checks passed`);
} finally {
  await browser.close();
  await t.close();
}
