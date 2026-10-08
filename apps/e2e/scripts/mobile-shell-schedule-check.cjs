/** H4 (docs/plans/tags-series-search-2026-10.md §3; prototype frame 5): the equipment schedule's header. The Fraunces
 *  heading "Equipment" stays in view when the screen opens (the timeline opens on today below it); Hours / Days / Weeks
 *  switch the scale; the date stepper ‹ day › moves a day (a week on Weeks) and "Today is …" goes back to today; the key
 *  (Confirmed, Maintenance, Cleaning) matches what is drawn, a booking's setup and cleaning time drawn as their own
 *  blocks; "Manage equipment" and "New booking" stay. Production export with synthetic, contract-shaped answers (shapes
 *  from apps/api/src/equipment). Not hosted, native or assistive technology. */
const { expect } = require('@playwright/test'); const path = require('node:path');
module.exports = async ({ browser, production, shots, width, scheme = 'light' }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, colorScheme: scheme });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const user = uuid(1), org = uuid(2), tom = uuid(42), f1 = uuid(60), f2 = uuid(61), line = uuid(62);
  const at = '2026-10-01T06:40:00.000Z', zone = 'Australia/Sydney';
  const errors = [], outside = [];
  const civil = (ms, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: zone, ...opts }).formatToParts(new Date(ms));
  const dateIn = ms => { const p = civil(ms, { year: 'numeric', month: '2-digit', day: '2-digit' }), g = t => p.find(x => x.type === t).value; return `${g('year')}-${g('month')}-${g('day')}`; };
  const local = (day, time) => { const guess = Date.parse(`${day}T${time}:00Z`); const p = civil(guess, { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), g = t => p.find(x => x.type === t).value;
   return new Date(guess - (Date.parse(`${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:00Z`) - guess)).toISOString(); };
  const shift = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const words = (day, long) => { const p = new Intl.DateTimeFormat('en-GB', { weekday: long ? 'long' : 'short', day: 'numeric', month: long ? 'long' : 'short', timeZone: 'UTC' }).formatToParts(new Date(`${day}T00:00:00Z`)), g = t => p.find(x => x.type === t).value;
   return `${g('weekday')} ${g('day')} ${long ? g('month') : g('month').slice(0, 3)}`; };
  const today = dateIn(Date.now());
  const equipment = [[f1, 'Fermenter 1'], [f2, 'Fermenter 2'], [line, 'Canning line']].map(([id, name]) => ({ id, name, archivedAt: null, revision: 1, createdAt: at, updatedAt: at }));
  const booking = (n, equipmentId, title, from, to, x = {}) => { const startsAt = local(today, from), endsAt = local(today, to), setup = x.setupMinutes ?? 0, cleanup = x.cleanupMinutes ?? 0;
   return { id: uuid(80 + n), equipmentId, title, kind: 'booking', status: 'confirmed', startsAt, endsAt, setupMinutes: setup, cleanupMinutes: cleanup, occupiedStartsAt: new Date(Date.parse(startsAt) - setup * 60000).toISOString(),
    occupiedEndsAt: new Date(Date.parse(endsAt) + cleanup * 60000).toISOString(), taskId: null, ownerId: null, createdBy: tom, revision: 1, createdAt: at, updatedAt: at, tagIds: [], ...x }; };
  const bookings = [booking(1, f1, 'Pale ale', '06:00', '14:00', { cleanupMinutes: 90 }), booking(2, f2, 'Keg wash', '07:00', '09:00', { kind: 'maintenance' }), booking(3, line, 'Summer lager canning run', '08:00', '16:00', { setupMinutes: 30, cleanupMinutes: 30 })];
  await context.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (url.origin !== production.origin) { outside.push(url.origin); return route.abort(); }
   const json = (status, value) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
   if (!url.pathname.startsWith('/v1/')) { const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1'; return route.fetch({ url: upstream.href, maxRedirects: 0 }).then(response => route.fulfill({ response })).catch(() => {}); }
   const p = url.pathname.replace(`/v1/organisations/${org}`, ''), method = req.method();
   expect(method).toBe('GET');
   if (url.pathname === '/v1/me') return json(200, { user: { id: user, name: 'Sam Skipper', email: 'sam@example.test' }, memberships: [{ organisationId: org, organisationName: 'Harbour Brewing', role: 'member', status: 'active' }], passkeyVerified: true });
   if (url.pathname === '/v1/me/passkeys') return json(200, { available: false, passkeys: [] });
   if (p === '') return json(200, { id: org, name: 'Harbour Brewing', timezone: zone, locale: 'en-AU', createdAt: at, role: 'member' });
   if (p === '/equipment') return json(200, { equipment, nextOffset: null });
   const one = equipment.find(e => p === `/equipment/${e.id}/reservations`);
   if (one) { const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    return json(200, { reservations: bookings.filter(b => b.equipmentId === one.id && Date.parse(b.occupiedStartsAt) < Date.parse(to) && Date.parse(b.occupiedEndsAt) > Date.parse(from)), nextOffset: null, coverage: 'complete', from, to, timezone: zone }); }
   return json(503, {});
  });
  page.on('pageerror', e => errors.push(e.message));
  const id = n => page.getByTestId(n).filter({ visible: true });
  const name = n => `${width}-${scheme === 'dark' ? 'dark-' : ''}schedule-${n}.png`;
  const shot = async n => { if (shots) await page.screenshot({ path: path.join(shots, name(n)) }); };
  const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const targets = async scope => { const small = await page.evaluate(sel => [...document.querySelectorAll(`${sel} [role="button"], ${sel} [role="radio"]`)].filter(e => e.offsetParent).map(e => { const r = e.getBoundingClientRect(); return [e.getAttribute('aria-label') ?? e.getAttribute('data-testid'), Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 44 || w < 44), scope); expect(small).toEqual([]); };

  await page.goto(new URL('/equipment', production).href);
  const heading = page.getByRole('heading', { name: 'Equipment', exact: true });
  await expect(heading).toBeVisible(); await expect(id('equipment-bar-' + uuid(81))).toBeVisible();
  await page.waitForTimeout(700); // the first settle
  // The heading is in view when the screen opens, and stays there: the timeline scrolls under it, opened on today.
  const box = await heading.boundingBox(); expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y).toBeLessThan(140);
  await expect(id('equipment-day')).toHaveText(words(today, true)); await expect(id('equipment-today')).toHaveText(`Today is ${words(today, false)}`);
  await expect(id('equipment-scale-days')).toHaveAttribute('aria-checked', 'true');
  await expect(id('equipment-manage-open')).toBeVisible(); await expect(id('equipment-new-booking')).toBeVisible();
  for (const label of ['Confirmed booking', 'Maintenance', 'Setup and cleaning time']) await expect(page.getByRole('listitem', { name: label, exact: true })).toBeVisible();
  await targets('[data-testid="equipment-header"]'); await overflow();
  // Hours: the working day, as frame 5 draws it, with cleaning and setup as their own blocks.
  await id('equipment-scale-hours').click(); await expect(id('equipment-scale-hours')).toHaveAttribute('aria-checked', 'true'); await expect(id('equipment-scale-days')).toHaveAttribute('aria-checked', 'false');
  await expect(id('equipment-cleanup').first()).toContainText('Cleaning'); await expect(id('equipment-setup').first()).toBeVisible();
  await expect(id('equipment-bar-' + uuid(81))).toContainText('Pale ale'); await expect(id('equipment-bar-' + uuid(81))).toContainText('6:00 am to 2:00 pm');
  await page.waitForTimeout(500); await shot('hours');
  expect((await heading.boundingBox()).y).toBe(box.y);
  // The stepper: a day each way on Hours and Days, a week on Weeks; Today comes back.
  await id('equipment-day-next').click(); await expect(id('equipment-day')).toHaveText(words(shift(today, 1), true));
  await id('equipment-day-previous').click(); await id('equipment-day-previous').click(); await expect(id('equipment-day')).toHaveText(words(shift(today, -1), true));
  await id('equipment-today').click(); await expect(id('equipment-day')).toHaveText(words(today, true));
  await id('equipment-scale-weeks').click(); await page.waitForTimeout(400);
  await expect(id('equipment-day-next')).toHaveAttribute('aria-label', 'Next week');
  const weekDay = (await id('equipment-day').textContent()).trim();
  await id('equipment-day-next').click(); await expect(id('equipment-day')).not.toHaveText(weekDay);
  await id('equipment-scale-days').click(); await id('equipment-today').click(); await expect(id('equipment-day')).toHaveText(words(today, true));
  await page.waitForTimeout(400); await shot('days'); await overflow();
  expect(errors).toEqual([]); expect(outside).toEqual([]);
  console.log(`PASS ${width}px${scheme === 'dark' ? ' dark' : ''}: schedule header (heading in view on open, Hours/Days/Weeks, ‹ day › and Today, the key, setup and cleaning blocks, Manage equipment and New booking kept)`);
 } finally { await context.close(); }
};
