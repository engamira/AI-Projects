// Browser smoke test for the sign-in, invitation, two-factor and admin screens.
// Runs the real built web app against a throwaway database schema. Usage: npm run e2e -w @cl/server
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createTestApp } from '../src/testkit.js';
import { currentCode } from '../src/totp.js';

try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));
} catch {
  /* CI provides DATABASE_URL */
}

const shots = process.env.E2E_SHOTS_DIR; // optional: where to save screenshots
const PORT = 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

const t = await createTestApp({ webDir });
const checks: string[] = [];
const ok = (name: string) => {
  checks.push(name);
  console.log(`PASS  ${name}`);
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL  ${msg}`);
}

const browser = await chromium.launch();
try {
  t.config.baseUrl = BASE; // invite links point at the test server
  await t.app.listen({ port: PORT, host: '127.0.0.1' });
  const admin = await t.seedUser('admin', { totp: true });

  // ---- Admin signs in with password + authenticator code
  const a = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  await a.goto(`${BASE}/`);
  await a.waitForURL('**/login');
  assert(await a.getByRole('heading', { name: 'Sign in' }).isVisible(), 'login page shown to signed-out visitors');
  await a.getByLabel('Email').fill(admin.email);
  await a.getByLabel('Password').fill('wrong password here');
  await a.getByRole('button', { name: 'Continue' }).click();
  await a.getByText('Invalid email or password.').waitFor();
  ok('wrong password is refused with a clear message');
  await a.getByLabel('Password').fill(admin.password);
  await a.getByRole('button', { name: 'Continue' }).click();
  await a.getByRole('heading', { name: 'Two-factor sign-in' }).waitFor();
  if (shots) await a.screenshot({ path: path.join(shots, '2-verify.png') });
  await a.getByLabel('Authenticator code').fill(currentCode(admin.totpSecret!));
  await a.getByRole('button', { name: 'Sign in' }).click();
  await a.getByRole('heading', { name: 'Emails', exact: true }).waitFor();
  ok('admin signs in with password and authenticator code');

  // ---- Admin creates a Builder and gets a one-time link
  await a.getByRole('link', { name: 'Users' }).click();
  await a.getByLabel('Name', { exact: true }).fill('Bella Builder');
  await a.getByLabel('Email', { exact: true }).fill('bella@example.test');
  await a.getByLabel('Role', { exact: true }).selectOption('builder');
  await a.getByRole('button', { name: 'Create and get link' }).click();
  const linkText = await a.locator('.notice code').innerText();
  assert(linkText.startsWith(`${BASE}/accept-invite?token=`), 'invite link shown to the Admin');
  if (shots) await a.screenshot({ path: path.join(shots, '5-users.png'), fullPage: true });
  ok('admin creates a user and receives a one-time link');

  // ---- Builder follows the link on a phone-sized screen, sets a password and enrolls 2FA
  const b = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await b.goto(linkText);
  await b.getByRole('heading', { name: 'Set your password' }).waitFor();
  await b.getByLabel('New password', { exact: true }).fill('a long enough password');
  await b.getByLabel('Repeat password').fill('a different password!');
  await b.getByRole('button', { name: 'Save password' }).click();
  await b.getByText('do not match').waitFor();
  await b.getByLabel('Repeat password').fill('a long enough password');
  await b.getByRole('button', { name: 'Save password' }).click();
  await b.getByText('Your password is set.').waitFor();
  ok('builder sets a password from the invitation link');
  const reuse = await b.goto(linkText);
  assert(reuse, 'reload invitation');
  await b.getByRole('heading', { name: 'Link not valid' }).waitFor();
  ok('the invitation link cannot be used twice');

  await b.goto(`${BASE}/login`);
  await b.getByLabel('Email').fill('bella@example.test');
  await b.getByLabel('Password').fill('a long enough password');
  await b.getByRole('button', { name: 'Continue' }).click();
  await b.getByRole('heading', { name: 'Set up two-factor sign-in' }).waitFor();
  await b.getByRole('img', { name: /QR code/ }).waitFor();
  if (shots) await b.screenshot({ path: path.join(shots, '3-enroll-mobile.png'), fullPage: true });
  await b.getByText("Can't scan?").click();
  const secret = (await b.locator('details code').innerText()).trim();
  await b.getByLabel('6-digit code').fill('000000');
  await b.getByRole('button', { name: 'Confirm' }).click();
  await b.getByText('That code is not correct').waitFor();
  await b.getByLabel('6-digit code').fill(currentCode(secret));
  await b.getByRole('button', { name: 'Confirm' }).click();
  await b.getByRole('heading', { name: 'Save your recovery codes' }).waitFor();
  assert((await b.locator('.codes span').count()) === 10, '10 recovery codes shown');
  const continueBtn = b.getByRole('button', { name: 'Continue' });
  assert(await continueBtn.isDisabled(), 'Continue is blocked until the codes are acknowledged');
  if (shots) await b.screenshot({ path: path.join(shots, '4-codes-mobile.png'), fullPage: true });
  await b.getByLabel('I have saved these codes').check();
  await continueBtn.click();
  await b.getByRole('heading', { name: 'Emails', exact: true }).waitFor();
  await b.getByText('Signed in as Bella Builder').waitFor();
  ok('builder enrolls an authenticator and receives 10 recovery codes');

  assert((await b.getByRole('link', { name: 'Users' }).count()) === 0, 'Builder sees no Users menu');
  b.on('dialog', (d) => void d.dismiss());
  await b.goto(`${BASE}/admin/users`);
  await b.getByRole('heading', { name: 'Emails', exact: true }).waitFor(); // redirected home: no access
  ok('builder cannot open the Users page (redirected home)');
  if (shots) await b.screenshot({ path: path.join(shots, '6-builder-home-mobile.png') });

  // horizontal overflow check on the phone layout
  const overflow = await b.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert(!overflow, 'no horizontal scrolling on a 390px screen');
  ok('phone layout has no horizontal overflow');

  // ---- Admin sees a notification and the activity history
  await a.reload();
  await a.getByRole('button', { name: /Notifications, 1 unread/ }).click();
  await a.getByText('Bella Builder set up their account').waitFor();
  if (shots) await a.screenshot({ path: path.join(shots, '7-bell.png') });
  ok('admin receives an in-app notification');
  await a.keyboard.press('Escape');
  await a.getByRole('link', { name: 'Activity' }).click();
  await a.getByText('Accepted invitation').waitFor();
  await a.getByText('Set up two-factor sign-in').first().waitFor().catch(() => undefined);
  if (shots) await a.screenshot({ path: path.join(shots, '8-activity.png'), fullPage: true });
  ok('activity history lists the sign-ins and invitation');

  // ---- Sign out
  await a.getByRole('button', { name: 'Sign out' }).click();
  await a.getByRole('heading', { name: 'Sign in' }).waitFor();
  ok('sign out returns to the login page');
  if (shots) await a.screenshot({ path: path.join(shots, '1-login.png') });

  console.log(`\n${checks.length} browser checks passed`);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await t.close();
}
