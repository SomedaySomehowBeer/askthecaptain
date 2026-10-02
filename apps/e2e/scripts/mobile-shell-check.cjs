/** R1b: production cookie-session client with synthetic API answers, plus the retained equipment/session-control
 * harness. Real Postgres cookie/CSRF tests live in apps/api/src/web/session.test.ts. Neither proves native devices. */
const { chromium, expect } = require('@playwright/test');
const { mkdir } = require('node:fs/promises');
const { generateKeyPairSync } = require('node:crypto');
const path = require('node:path');
const base = new URL(process.env.MOBILE_SHELL_URL ?? 'http://127.0.0.1:8092');
const production = new URL(process.env.MOBILE_PRODUCTION_URL ?? 'http://127.0.0.1:8093');
for (const url of [base, production]) if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Exports must be loopback HTTP origins');
// WebAuthn RP IDs are domain names; localhost is a secure-context exception in Chromium.
production.hostname = 'localhost';
const shots = process.env.MOBILE_SHELL_SCREENSHOTS;
const user = { id: '00000000-0000-4000-8000-000000000001', email: 'person@example.test', name: 'Sam Skipper' };
const a = { organisationId: '00000000-0000-4000-8000-000000000002', organisationName: 'Harbour Brewing', role: 'owner', status: 'active' };
const b = { ...a, organisationId: '00000000-0000-4000-8000-000000000003', organisationName: 'Quayside Cellars', role: 'member' };
(async () => {
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch({ headless: true });
 try {
  if (shots) await mkdir(shots, { recursive: true });
  for (const width of [360, 390, 430, 1280]) {
   // Isolated sessions are required: storage, cookie identity and WebAuthn must not touch the shared browser account.
   const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500 });
   try {
    let identity = 'signed-out', memberships = [a], invite = 'accepted', signOut = 'ok', passkeys = 'empty';
    let page; const errors = [], outside = [], requests = []; let assertion = null;
    await context.route('**/*', async route => {
     const request = route.request(), url = new URL(request.url());
     if (![base.origin, production.origin].includes(url.origin)) { outside.push(url.origin); return route.abort(); }
     const json = (status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
     if (url.pathname.startsWith('/v1/') || ['/auth/sign-out', '/auth/passkey/options', '/auth/passkey/verify'].includes(url.pathname)) {
      requests.push({ path: url.pathname, method: request.method(), headers: request.headers() });
      expect(request.headers()['x-captain-client']).toBe('web'); expect(request.headers().authorization).toBeUndefined();
      if (url.pathname === '/v1/me') {
       if (identity === 'signed-out') return json(401, { error: { code: 'unauthorised' } });
       if (identity === 'unavailable') return json(503, { error: { code: 'unavailable' } }, { 'retry-after': '1' });
       return json(200, { user, memberships, passkeyVerified: true });
      }
      if (url.pathname === '/auth/sign-out') {
       if (signOut === 'fail') return json(503, { error: { code: 'unavailable' } }, { 'retry-after': '5' });
       identity = 'signed-out'; return json(200, { ok: true });
      }
      if (url.pathname === '/v1/me/passkeys') {
       if (passkeys === 'fail') return json(503, { error: { code: 'unavailable' } });
       return json(200, { available: true, passkeys: passkeys === 'empty' ? [] : [{ id: '00000000-0000-4000-8000-000000000005', name: 'Sample passkey', deviceType: 'multiDevice', backedUp: true, createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null }] });
      }
      if (/\/threads$/.test(url.pathname)) return json(200, { filter: url.searchParams.get('filter') || 'all', available: true, threads: [], groups: [], nextCursor: null });
      if (url.pathname === '/v1/me/sessions/revoke-others') return json(200, { ended: 2 });
      if (url.pathname === '/v1/invitations/accept') {
       if (invite === 'unknown') return route.abort();
       if (invite === 'refused') return json(403, { error: { code: 'forbidden' } });
       memberships = [a, b]; return json(200, b);
      }
      if (url.pathname === '/auth/passkey/options') return json(200, { options: { challenge: Buffer.from('synthetic challenge').toString('base64url'), rpId: production.hostname, timeout: 30000, userVerification: 'preferred', allowCredentials: [{ id: Buffer.from('synthetic credential').toString('base64url'), type: 'public-key' }] } });
      if (url.pathname === '/auth/passkey/verify') { assertion = request.postDataJSON().response; identity = 'signed-in'; return json(200, { ok: true, expiresAt: '2026-10-30T00:00:00.000Z', user, returnTo: '/settings' }); }
      return json(503, { error: { code: 'unavailable' } });
     }
     const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1';
     await route.fulfill({ response: await route.fetch({ url: upstream.href, maxRedirects: 0 }) });
    });
    const freshPage = async () => { if (page) await page.close(); page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); };
    const id = name => page.getByTestId(name).filter({ visible: true });
    const heading = text => page.getByRole('heading', { name: text, exact: true });
    const go = route => page.goto(new URL(route, production).href);
    const noOverflow = async where => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth), `${width}px ${where}`).toBeLessThanOrEqual(1);
    const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-${name}.png`), fullPage: true }); };
    const scenario = async (name, route = '/') => { await page.goto(new URL(`${route}?scenario=${name}`, base).href); await expect(page.getByTestId('harness-scenario')).toHaveText(name); };
    await freshPage(); await go('/equipment'); await expect(id('web-sign-in')).toBeVisible();
    expect(new URL(await id('web-sign-in').getAttribute('href')).searchParams.get('return_to')).toBe('/equipment');
    await noOverflow('welcome'); await shot('welcome');
    await go('/unknown?token=shell-canary'); await expect(page.getByText('shell-canary')).toHaveCount(0); await noOverflow('refused link');
    identity = 'signed-in'; memberships = [a, b]; await freshPage(); await go('/');
    await expect(heading('Threads')).toBeVisible(); await expect(id('shell-organisation')).toHaveText(a.organisationName);
    await expect(page.getByRole('tab')).toHaveCount(0); await expect(page.getByRole('radio')).toHaveCount(8);
    await expect(id('threads-empty')).toBeVisible();
    for (let n=0;n<8;n++) { if(n<6) await expect(id(`threads-filter-${n}`)).toBeEnabled(); else await expect(id(`threads-filter-${n}`)).toBeDisabled(); }
    await expect(id('threads-pinned-team')).toHaveAttribute('aria-disabled', 'true');
    await expect(id('threads-empty')).toContainText('No threads match'); await noOverflow('home'); await shot('home');
    await page.getByRole('button', { name: 'Account and settings', exact: true }).click(); await expect(heading('Account')).toBeVisible();
    await expect(id('account-passkeys-none')).toBeVisible(); await id('account-action-switch').click();
    await page.getByRole('button', { name: new RegExp(b.organisationName) }).click();
    await expect(id('shell-organisation')).toHaveText(b.organisationName);
    await page.reload(); await expect(id('shell-organisation')).toHaveText(b.organisationName);
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).toEqual({ local: { [`captain.organisation.${user.id}`]: b.organisationId }, session: {} });
    passkeys = 'loaded'; await go('/settings'); await expect(page.getByText('Sample passkey', { exact: true })).toBeVisible(); await noOverflow('settings'); await shot('settings');
    await id('account-action-revoke-others').click(); await id('account-action-revoke-others-confirm').click(); await expect(id('account-revoke-others-status')).toContainText('2 other active sessions ended.');
    await id('account-action-sign-out').click(); await id('account-action-sign-out-confirm').click(); await expect(id('web-sign-in')).toBeVisible();
    identity = 'signed-in'; memberships = []; await freshPage(); await go('/settings'); await expect(heading('Account')).toBeVisible(); await expect(page.getByText('No organisation selected')).toBeVisible();
    memberships = [a]; passkeys = 'fail'; await freshPage(); await go('/settings'); await expect(id('account-passkeys-failed')).toBeVisible();
    passkeys = 'empty'; await id('account-passkeys-try-again').click(); await expect(id('account-passkeys-none')).toBeVisible();
    signOut = 'fail'; await id('account-action-sign-out').click(); await id('account-action-sign-out-confirm').click(); await expect(heading("Couldn't confirm you're signed out")).toBeVisible(); await expect(id('web-try-again')).toBeDisabled(); signOut = 'ok';
    identity = 'unavailable'; await freshPage(); await page.clock.install(); await go('/equipment'); await expect(heading("Couldn't check your sign-in")).toBeVisible(); expect(new URL(page.url()).pathname).toBe('/equipment');
    await expect(id('web-try-again')).toBeDisabled(); await noOverflow('unavailable'); await shot('unavailable');
    identity = 'signed-in'; await page.clock.fastForward(31_000); await expect(heading('Equipment schedule')).toBeVisible(); expect(new URL(page.url()).pathname).toBe('/equipment');
    await freshPage(); await go('/invitations/accept?token=synthetic'); await id('invitation-accept').click(); await expect(heading('Threads')).toBeVisible(); await expect(id('shell-organisation')).toHaveText(b.organisationName);
    invite = 'refused'; await go('/invitations/accept?token=refused'); await id('invitation-accept').click(); await expect(id('invitation-refused')).toBeVisible();
    invite = 'unknown'; await go('/invitations/accept?token=unknown'); await id('invitation-accept').click(); await expect(id('invitation-unknown')).toBeVisible(); await expect(id('invitation-accept')).toHaveCount(0); await noOverflow('invitation');
    // Exercise a real browser WebAuthn assertion, with synthetic options and a mocked verify response (not API cryptographic proof).
    await freshPage(); const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: Buffer.from('synthetic credential').toString('base64'), isResidentCredential: false, rpId: production.hostname, privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), signCount: 0 } });
    identity = 'signed-out'; await go('/auth/passkey'); await expect(heading('Account')).toBeVisible(); expect(assertion?.response?.signature).toBeTruthy(); await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }); await cdp.detach();
    await require('./mobile-shell-members-check.cjs')({ browser, production, base, shots, width });
    // Retain deeper read-only timeline and revocation UI regression checks at phone widths.
    if (width < 500) {
     await require('./mobile-shell-push-check.cjs')({ browser, production, base, shots, width });
     await require('./mobile-shell-threads-check.cjs')({ browser, production, base, shots, width });
     await require('./mobile-shell-create-check.cjs')({ browser, production, base, shots, width });
     await require('./mobile-shell-cards-check.cjs')({ browser, production, base, shots, width });
     if (width === 390) await require('./mobile-shell-cards-check.cjs')({ browser, production, shots, width, scheme: 'dark' });
     await require('./mobile-shell-history-check.cjs')({ browser, production, base, shots, width });
     if (width === 390) await require('./mobile-shell-history-check.cjs')({ browser, production, shots, width, scheme: 'dark' });
     await require('./mobile-shell-design-check.cjs')({ browser, production, shots, width });
     await require('./mobile-shell-passkeys-check.cjs')({ browser, production, base, shots, width });
     await require('./mobile-shell-revocation-check.cjs')({ getPage: () => page, freshPage, scenario, shot, noOverflow, width });
     await require('./mobile-shell-equipment-check.cjs')({ getPage: () => page, freshPage, scenario, shot, noOverflow, width });
     // Dark and light colour schemes over the harness scenarios, at the reference frames' width.
     if (width === 390) await require('./mobile-shell-dark-check.cjs')({ browser, base, shots, width });
    }
    expect(errors).toEqual([]); expect(outside).toEqual([]);
    console.log(`PASS ${width}px: cookie client, navigation, storage, outages, invitations, passkeys and sign-out; no overflow or page errors`);
   } finally { await context.close(); }
  }
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
