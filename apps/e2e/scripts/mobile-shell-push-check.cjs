/** Synthetic push transport and browser permission adapter; never contacts a push provider. */
const { expect } = require('@playwright/test');
const path = require('node:path');
module.exports = async ({ browser, production, base, shots, width }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 } });
 try {
  const page = await context.newPage(); await page.clock.install();
  const id = value => page.getByTestId(value).filter({ visible: true });
  const org = '00000000-0000-4000-8000-000000000001', person = '00000000-0000-4000-8000-000000000002', deviceId = '00000000-0000-4000-8000-000000000003';
  const endpoint = 'https://push.example.test/synthetic';
  const device = { id: deviceId, endpoint, userAgent: 'Synthetic mobile browser', createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null };
  let devices = [], mode = 'ok', configured = true, writes = 0, release;
  const errors = [], outside = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.addInitScript(({ endpoint }) => {
   window.__permission = 'granted'; window.__pushCalls = 0;
   Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return window.__permission === 'granted' ? 'default' : window.__permission; }, async requestPermission() { if (window.__holdPermission) await new Promise(resolve => { window.__releasePermission = resolve; }); return window.__permission; } } });
   Object.defineProperty(window, 'PushManager', { configurable: true, value: function() {} });
   Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { async register(url) { if (url !== '/sw.js') throw new Error('unexpected worker'); return { active: {}, pushManager: { async getSubscription() { return null; }, async subscribe() { window.__pushCalls++; return { toJSON() { return { endpoint, keys: { p256dh: 'synthetic', auth: 'synthetic' } }; } }; } } }; } } });
  }, { endpoint });
  await context.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (![production.origin, base.origin].includes(url.origin)) { outside.push(url.origin); return route.abort(); }
   const json = (status, value, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(value) });
   if (url.pathname.startsWith('/v1/')) {
    expect(req.headers()['x-captain-client']).toBe('web'); expect(req.headers().authorization).toBeUndefined();
    if (url.pathname === '/v1/me') return json(200, { user: { id: person, name: 'Sam', email: 'sam@example.test' }, memberships: [{ organisationId: org, organisationName: 'Harbour Brewing', role: 'member', status: 'active' }], passkeyVerified: true });
    if (url.pathname === '/v1/me/passkeys') return json(200, { available: false, passkeys: [] });
    if (mode === '401') return json(401, {});
    if (req.method() === 'GET') {
     if (mode === 'failed') return json(503, {});
     if (mode === 'hold') return new Promise(resolve => { release = async () => { mode = 'ok'; await json(200, { configured, publicKey: configured ? 'B' + 'a'.repeat(86) : null }); resolve(); }; });
     return json(200, url.pathname.endsWith('/config') ? { configured, publicKey: configured ? 'B' + 'a'.repeat(86) : null } : { subscriptions: devices });
    }
    writes++;
    if (mode === 'unknown') return json(503, {}, { 'retry-after': '5' });
    if (req.method() === 'DELETE') { expect(req.postDataJSON()).toEqual({ endpoint }); devices = []; return json(200, { ok: true }); }
    if (url.pathname.endsWith('/test')) return json(200, { deliveries: [{ subscriptionId: deviceId, state: mode === 'gone' ? 'gone' : 'sent', statusCode: mode === 'gone' ? 410 : 201, error: null }] });
    expect(req.postDataJSON().endpoint).toBe(endpoint); devices = [device]; return json(201, device);
   }
   const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1';
   return route.fetch({ url: upstream.href, maxRedirects: 0 }).then(response => route.fulfill({ response })).catch(() => { /* the page closed with the file in flight (a font swapping in) */ });
  });
  const go = route => page.goto(new URL(route, production).href);
  const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-push-${name}.png`), fullPage: true }); };
  await go('/settings'); await id('account-notifications').click(); await expect(id('push-empty')).toBeVisible(); await expect(id('push-test')).toBeDisabled();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await id('push-register').click(); await expect(id(`push-device-${deviceId}`)).toBeVisible(); await expect(id('push-status')).toContainText('registered'); await overflow(); await shot('registered');
  await id('push-test').click(); await expect(id('push-status')).toContainText('accepted 1'); await expect(id('push-status')).toContainText('does not confirm');
  mode = 'gone'; await id('push-test').click(); await expect(id('push-status')).toContainText('expired devices 1');
  mode = 'unknown'; await id('push-test').click(); const before = writes; await expect(id('push-status')).toContainText('may have completed'); await expect(id('push-refresh')).toBeDisabled(); await page.clock.fastForward(5100); await expect(id('push-refresh')).toBeEnabled(); await expect(id('push-test')).toBeDisabled(); expect(writes).toBe(before);
  mode = 'ok'; await id('push-refresh').click(); await expect(id('push-test')).toBeEnabled(); await id(`push-remove-${deviceId}`).click(); await expect(id('push-empty')).toBeVisible();
  mode = 'failed'; await id('push-refresh').click(); await expect(id('push-status')).toContainText('Could not load'); await expect(id('push-empty')).toHaveCount(0); await shot('failed'); mode = 'ok'; await id('push-refresh').click(); await expect(id('push-empty')).toBeVisible();
  mode = 'hold'; await id('push-refresh').click(); await expect(id('push-loading')).toBeVisible(); await expect.poll(() => Boolean(release)).toBe(true); await release(); await expect(id('push-register')).toBeEnabled();
  await page.evaluate(() => { window.__permission = 'denied'; }); await id('push-register').click(); await id('push-refresh').click(); await expect(id('push-support')).toContainText('blocked'); await expect(id('push-register')).toBeDisabled();
  configured = false; await id('push-refresh').click(); await expect(id('push-unavailable')).toBeVisible(); await expect(id('push-register')).toBeDisabled();
  configured = true; await page.evaluate(() => { window.__permission = 'granted'; }); await id('push-refresh').click(); await expect(id('push-register')).toBeEnabled();
  // Leaving while a browser permission prompt is pending must never post the late subscription.
  await page.evaluate(() => { window.__holdPermission = true; }); await id('push-register').click(); await expect(id('push-saving')).toBeVisible(); await expect(id('push-refresh')).toBeDisabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); const count = writes; await page.evaluate(() => window.__releasePermission()); await expect(id('account-notifications')).toBeVisible(); expect(writes).toBe(count);
  await id('account-notifications').click(); await expect(id('push-empty')).toBeVisible(); mode = '401'; await id('push-refresh').click(); await expect(id('web-sign-in')).toBeVisible();
  for (const [scenario, target] of [['push-empty','push-empty'], ['push-loaded', `push-device-00000000-0000-4000-8000-000000000005`], ['push-unavailable','push-unavailable'], ['push-failed','push-status']]) {
   await page.goto(new URL(`/settings/notifications?scenario=${scenario}`, base).href); await expect(id(target)).toBeVisible(); await overflow();
  }
  await page.goto(new URL('/settings/notifications?scenario=ready', base).href); await expect(page.getByText('Push notification controls are available in the browser. Native push is not available yet.')).toBeVisible();
  expect(errors).toEqual([]); expect(outside).toEqual([]);
  console.log(`PASS ${width}px: push registration/removal/test, delivery counts, permission/unavailable/failed/loading/pending states, uncertain-write backoff, leaving during permission, 401 and native notice`);
 } finally { await context.close(); }
};
