/** Real disposable API/Postgres and production web: other-session revocation, plus explicitly synthetic faults.
 * No live account or deployed test switch. The runner owns fixture/server cleanup and secret redaction. */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:3034', apiOrigin = 'http://127.0.0.1:8084';
const directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw Error('WORKSPACE_PROBE_DIR required');
(async () => {
 const f = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(f.fixture, 'captain-workspace-local');
 const tokens = ['token','ownerOtherToken','memberToken','memberOtherToken'].map(key => {
  assert.equal(typeof f[key], 'string', `fresh fixture requires ${key}`); return f[key];
 });
 const secrets = tokens.flatMap(token => [token, createHash('sha256').update(token).digest('hex')]);
 const noSecrets = text => { for (const value of secrets) assert.ok(!text.includes(value), 'a token or hash reached the rendered page or action result'); };
 const mode = value => writeFile(path.join(directory, 'mode'), value);
 const stats = async () => (await (await fetch(apiOrigin + '/__fixture/stats')).json()).revocationRequests;
 const call = (token, route) => fetch(apiOrigin + route, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 const contexts = [], errors = [], actionBodies = [];
 let abortAction = false;
 async function signedIn(token) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
  await context.addCookies([{ name: 'captain_session', value: token, url: origin }]);
  // Routing also reaches the host from shared Chromium's Docker namespace.
  await context.route(`${origin}/**`, async route => {
   const request = route.request();
   const action = request.method() === 'POST' && !!request.headers()['next-action'];
   if (action && abortAction) { abortAction = false; await route.abort('failed'); return; }
   const response = await route.fetch({ maxRedirects: 0 });
   if (action) actionBodies.push(await response.text());
   const location = response.headers().location;
   if (location && response.status() >= 300 && response.status() < 400 && request.isNavigationRequest()) {
    const destination = new URL(location, request.url()).href;
    await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination).replace(/</g, '\\u003c')})</script>` });
   } else await route.fulfill({ response });
  });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  return page;
 }
 const page = await signedIn(f.token), other = await signedIn(f.ownerOtherToken);
 const control = p => p.getByRole('button', { name: 'Sign out everywhere else', exact: true }).last();
 const main = p => p.locator('main');
 const open = async p => { await control(p).click(); await expect(p.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible(); };
 const reload = async p => { await p.goto(origin + '/settings'); await expect(control(p)).toBeVisible(); };
 try {
  await mode(''); await reload(page); await reload(other);
  const before = await stats(); await open(page); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await stats(), before, 'cancel sent a write'); await reload(other);
  console.log('PASS cancel sends no revocation and the second browser remains signed in');

  await open(page); await mode('revoke-delayed'); await control(page).click();
  await expect(page.getByRole('button', { name: 'Signing out everywhere else…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await expect(main(page)).toContainText('1 other active session ended.'); await mode('');
  await expect(page).toHaveURL(/\/settings$/); noSecrets(await page.content());
  await other.goto(origin + '/settings'); await expect(other).toHaveURL(/\/sign-in\?/);
  for (const width of [360,390,430,1440]) {
   await page.setViewportSize({ width, height: 900 });
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
   await page.screenshot({ path: path.join(directory, `session-revocation-${width}.png`) });
  }
  console.log('PASS confirmed real revocation keeps this browser, ends the other, disables duplicates and fits phone/desktop');

  await reload(page); await open(page); await control(page).click();
  await expect(main(page)).toContainText('No other active sessions were ended.');
  for (const [fault, expected] of [
   ['revoke-rate-limited', 'Too many attempts. Try again in 2 seconds.'],
   ['revoke-refused', "Captain couldn’t sign out your other sessions."],
   ['revoke-uncertain', "Captain couldn’t confirm whether your other sessions were ended. It’s safe to try again."]
  ]) {
   await mode(''); await reload(page); await open(page); await mode(fault); await control(page).click();
   await expect(main(page)).toContainText(expected); noSecrets(await page.content());
  }
  console.log('PASS zero count, rate limit, refusal and lost response after a real committed API call');

  await mode(''); await reload(page); await open(page); abortAction = true; await control(page).click();
  await expect(main(page)).toContainText("Captain couldn’t confirm whether your other sessions were ended. It’s safe to try again.");
  console.log('PASS browser-to-Next action failure renders unknown instead of an error boundary');

  const member = await signedIn(f.memberToken); await reload(member); await open(member);
  assert.equal((await call(f.memberOtherToken, '/v1/me/sessions/revoke-others')).status, 200);
  const afterOther = await stats(); await control(member).click();
  await expect(main(member)).toContainText('Your session has ended. Sign in again; nothing was sent.');
  assert.equal(await stats(), afterOther, 'failed session preflight sent a revocation');
  await expect(member.getByRole('link', { name: 'Sign in again', exact: true })).toHaveAttribute('href', '/sign-in?return_to=%2Fsettings');
  await member.getByRole('link', { name: 'Sign in again', exact: true }).click();
  await expect(member).toHaveURL(/\/sign-in\?/);
  console.log('PASS a session ended before confirmation is refused before sending and offers sign-in recovery');

  await reload(page); await open(page); await mode('revoke-expire-before-send'); await control(page).click();
  await expect(page).toHaveURL(/\/sign-in\?return_to=(?:%2F|\/)settings/);
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
  console.log('PASS synthetic expiry between preflight and POST preserves Next redirect handling');
  for (const body of actionBodies) noSecrets(body);
  assert.deepEqual(errors, []); console.log('PASS no page errors, tokens or hashes in HTML/action results');
 } catch (error) {
  await page.screenshot({ path: path.join(directory, 'session-revocation-failure.png'), fullPage: true }).catch(() => {}); throw error;
 } finally {
  await mode(''); for (const context of contexts) await context.close(); await browser.close();
 }
})().catch(error => { console.error(error); process.exitCode = 1; });
