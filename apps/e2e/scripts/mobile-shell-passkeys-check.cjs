/** R2a passkeys: real browser registration/assertion with a virtual authenticator, synthetic API answers.
 * Pure tests cover person/unmount races. This is not hosted Google/WebAuthn server verification. */
const { expect } = require('@playwright/test');
const path = require('node:path');
module.exports = async ({ browser, production, base, shots, width }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000); await page.clock.install();
  const user = { id: '00000000-0000-4000-8000-000000000001', email: 'passkeys@example.test', name: 'Sam Skipper' };
  const member = { organisationId: '00000000-0000-4000-8000-000000000002', organisationName: 'Harbour Brewing', role: 'owner', status: 'active' };
  const keyId = '00000000-0000-4000-8000-000000000005';
  const key = { id: keyId, name: 'Phone', deviceType: 'multiDevice', backedUp: true, createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null };
  let keys = [], listMode = 'ok', removeMode = 'ok', registerMode = 'ok', signedIn = true, holdOptions = false, releaseOptions;
  let registration, assertion, writes = 0; const errors = [], outside = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = name => page.getByTestId(name).filter({ visible: true });
  const go = route => page.goto(new URL(route, production).href);
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-passkeys-${name}.png`), fullPage: true }); };
  const noOverflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  await context.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (![production.origin, base.origin].includes(url.origin)) { outside.push(url.origin); return route.abort(); }
   const json = (status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
   if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/auth/passkey/')) {
    expect(req.headers()['x-captain-client']).toBe('web'); expect(req.headers().authorization).toBeUndefined();
    if (url.pathname === '/v1/me') return signedIn ? json(200, { user, memberships: [member], passkeyVerified: true }) : json(401, {});
    if (url.pathname === '/v1/me/passkeys/options') {
     const respond = () => json(200, { token: 'pkr_' + 'a'.repeat(43), options: { challenge: Buffer.from('registration challenge').toString('base64url'), rp: { id: production.hostname, name: 'Captain test' }, user: { id: Buffer.from(user.id).toString('base64url'), name: user.email, displayName: user.name }, pubKeyCredParams: [{ alg: -7, type: 'public-key' }], timeout: 30000, attestation: 'none', authenticatorSelection: { userVerification: 'preferred' } } });
     if (holdOptions) return new Promise(resolve => { releaseOptions = async () => { await respond(); resolve(); }; });
     return respond();
    }
    if (url.pathname === '/v1/me/passkeys' && req.method() === 'POST') {
     writes++; registration = req.postDataJSON(); expect(registration.token).toBe('pkr_' + 'a'.repeat(43)); expect(registration.response.response.attestationObject).toBeTruthy();
     if (registerMode === 'expired') return json(400, { code: 'challenge_invalid', message: 'that registration has expired; start again' });
     keys = [{ ...key, name: registration.name || 'Passkey' }]; return json(201, keys[0]);
    }
    if (url.pathname === '/v1/me/passkeys') {
     if (listMode === 'fail') return json(503, {});
     if (listMode === 'unavailable') return json(200, { available: false, passkeys: [] });
     return json(200, { available: true, passkeys: keys });
    }
    if (url.pathname === `/v1/me/passkeys/${keyId}` && req.method() === 'DELETE') {
     writes++;
     if (removeMode === 'unknown') { keys = []; return json(503, {}, { 'retry-after': '5' }); }
     if (removeMode === '401') return json(401, {});
     keys = []; return json(200, { ok: true });
    }
    if (url.pathname === '/auth/passkey/options') return json(200, { options: { challenge: Buffer.from('assertion challenge').toString('base64url'), rpId: production.hostname, timeout: 30000, userVerification: 'preferred', allowCredentials: [{ id: registration.response.id, type: 'public-key' }] } });
    if (url.pathname === '/auth/passkey/verify') { assertion = req.postDataJSON().response; signedIn = true; return json(200, { ok: true, expiresAt: '2026-10-30T00:00:00.000Z', user, returnTo: '/settings' }); }
    return json(503, {});
   }
   const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1';
   return route.fulfill({ response: await route.fetch({ url: upstream.href, maxRedirects: 0 }) });
  });
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await go('/settings'); await expect(id('account-passkeys-none')).toBeVisible();
  await id('passkey-name').fill('My phone'); await id('passkey-add').click();
  await expect(id(`account-passkey-${keyId}`)).toContainText('My phone'); await expect(id('passkey-status')).toContainText('Every sign-in'); await noOverflow(); await shot('added');
  expect(registration.name).toBe('My phone');
  // The credential just created can perform the existing next-sign-in step-up.
  signedIn = false; await go('/auth/passkey'); await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible(); expect(assertion.response.signature).toBeTruthy();
  await id(`passkey-remove-${keyId}`).click(); await expect(id('account-passkeys-none')).toBeVisible(); await expect(id('passkey-status')).toContainText('removed');
  // Script browser cancellation; no registration write follows the cancelled ceremony.
  const beforeCancel = writes;
  await page.evaluate(() => { const original = navigator.credentials.create.bind(navigator.credentials); navigator.credentials.create = async (...args) => { navigator.credentials.create = original; throw new DOMException('synthetic cancellation', 'NotAllowedError'); }; });
  await id('passkey-add').click(); await expect(id('passkey-status')).toContainText('dismissed'); expect(writes).toBe(beforeCancel);
  registerMode = 'expired'; await id('passkey-add').click(); await expect(id('passkey-status')).toContainText('expired'); registerMode = 'ok';
  await id('passkey-add').click(); await expect(id(`account-passkey-${keyId}`)).toBeVisible();
  removeMode = 'unknown'; await id(`passkey-remove-${keyId}`).click();
  await expect(id('passkey-status')).toContainText("Couldn't confirm"); await expect(id('passkey-refresh')).toBeDisabled(); await expect(id('passkey-add')).toBeDisabled(); await shot('uncertain');
  await page.clock.fastForward(5100); await expect(id('passkey-refresh')).toBeEnabled(); await expect(id('passkey-add')).toBeDisabled(); await id('passkey-refresh').click(); await expect(id('account-passkeys-none')).toBeVisible(); await expect(id('passkey-add')).toBeEnabled(); removeMode = 'ok';
  listMode = 'fail'; await id('passkey-refresh').click(); await expect(id('account-passkeys-failed')).toBeVisible(); await expect(id('passkey-add')).toHaveCount(0); await shot('failed');
  listMode = 'unavailable'; await id('account-passkeys-try-again').click(); await expect(id('account-passkeys-unavailable')).toBeVisible();
  listMode = 'ok'; await id('passkey-refresh').click(); holdOptions = true; const beforeLeave = writes;
  await id('passkey-add').click(); await expect(id('passkey-busy')).toBeVisible(); await expect(id('passkey-add')).toBeDisabled();
  await expect.poll(() => Boolean(releaseOptions)).toBe(true);
  await page.getByRole('button', { name: 'Back', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible(); await releaseOptions(); holdOptions = false;
  expect(writes).toBe(beforeLeave);
  keys = [key]; await go('/settings'); removeMode = '401'; await id(`passkey-remove-${keyId}`).click(); await expect(id('web-sign-in')).toBeVisible();
  // Separate harness states use the same component with no server requests.
  for (const [scenario, target] of [['passkeys-empty', 'account-passkeys-none'], ['passkeys-loaded', `account-passkey-${keyId}`], ['passkeys-unavailable', 'account-passkeys-unavailable'], ['passkeys-failed', 'account-passkeys-failed']]) {
   await page.goto(new URL(`/settings?scenario=${scenario}`, base).href); await expect(id(target)).toBeVisible(); await noOverflow();
  }
  await page.goto(new URL('/settings?scenario=ready', base).href); await expect(page.getByText('This version lists passkeys in the browser only.')).toBeVisible(); await expect(id('passkey-add')).toHaveCount(0);
  await page.addInitScript(() => { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); });
  removeMode = 'ok'; await go('/settings'); await expect(id('passkey-unsupported')).toBeVisible(); await expect(id('passkey-add')).toHaveCount(0); await noOverflow();
  expect(errors).toEqual([]); expect(outside).toEqual([]);
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }); await cdp.detach();
  console.log(`PASS ${width}px: passkey registration, next-sign-in assertion, removal, cancellation, refusal, uncertain-write reconciliation, session expiry and harness states`);
 } finally { await context.close(); }
};
