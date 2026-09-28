/** Equipment schedule: production parser, pure state and UI over explicit synthetic answers (contract §6 harness row),
 *  not native/device proof. One read at a time through the screen's coordinator; only complete cells may look free. */
const { expect } = require('@playwright/test');
module.exports = async ({ getPage, freshPage, scenario, shot, noOverflow, width }) => {
 const page = () => getPage();
 const id = name => page().locator(`[data-testid="${name}"]:visible`);
 const eq = name => id(`equipment-${name}`);
 const bars = () => page().locator('[data-testid^="equipment-bar-"]:visible');
 const bar = title => bars().filter({ hasText: title }).first();
 const log = async () => JSON.parse(await page().getByTestId('work-read-log').textContent());
 const count = async n => expect.poll(async () => (await log()).length, { timeout: 15_000 }).toBe(n);
 const atLeast = async n => expect.poll(async () => (await log()).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(n);
 const last = async () => new URL((await log()).at(-1).path, 'https://example.invalid');
 const answer = async name => page().getByTestId(`harness-read-${name}`).click();
 const orgPath = /^\/v1\/organisations\/[0-9a-f-]+$/, pagePath = /^\/v1\/organisations\/[0-9a-f-]+\/equipment$/, occPath = /^\/v1\/organisations\/[0-9a-f-]+\/equipment\/[0-9a-f-]+\/reservations$/;
 const start = async (freeze = false) => {
  await freshPage();
  if (freeze) { await page().clock.install(); await page().clock.pauseAt(await page().evaluate(() => Date.now())); }
  await scenario('ready', '/resources');
  await expect(page().getByRole('heading', { name: 'Equipment schedule', exact: true })).toBeVisible();
  await expect(eq('loading')).toHaveText('Loading the schedule…'); await count(1);
  const url = await last(); expect(url.pathname).toMatch(orgPath); expect(url.search).toBe('');
 };
 /** Bootstrap and page 0 with the given controls; returns after page 0 is answered. */
 const bootstrap = async (org = 'equipment-ok', page0 = 'equipment-ok') => {
  await answer(org); await count(2);
  const url = await last(); expect(url.pathname).toMatch(pagePath); expect(url.search).toBe('?limit=100&offset=0');
  await answer(page0);
 };
 const occupancy = async () => { const url = await last(); expect(url.pathname).toMatch(occPath); expect(url.searchParams.get('limit')).toBe('200'); return url; };

 // The happy path: organisation, then page 0, then occupancy one at a time after the view settles.
 await start(); await bootstrap();
 await expect(eq('zone')).toHaveText('Times in Australia/Sydney');
 await expect(page().getByText('Sample fermenter', { exact: true }).first()).toBeVisible();
 await expect(eq('legend')).toBeVisible(); await expect(eq('hatch').first()).toBeVisible();
 await atLeast(3); const first = await occupancy();
 expect(first.searchParams.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
 await expect.poll(async () => (await log()).length).toBe(3); // one flight: nothing else while it is pending
 await answer('equipment-ok');
 await expect(bar('Sample overnight brew')).toBeVisible({ timeout: 15_000 }); await expect(bar('Sample clean in place')).toBeVisible();
 await noOverflow('equipment timeline'); await shot('equipment-loaded');
 await atLeast(4); await occupancy(); await answer('equipment-partial');
 await expect(page().getByText('Not every reservation is shown for these dates. Gaps are not confirmed free.').first()).toBeVisible({ timeout: 15_000 });
 const partialReads = (await log()).length;
 // A partial cell is never re-read automatically; the next read, if any, is another cell.
 await expect.poll(async () => (await log()).length).toBeGreaterThanOrEqual(partialReads);
 await bar('Sample overnight brew').click();
 await expect(eq('panel')).toContainText('Sample overnight brew'); await expect(eq('panel')).toContainText('Sample fermenter');
 await eq('panel-close').click(); await expect(eq('panel')).toHaveCount(0);
 await eq('scale-hours').click(); await expect(eq('hatch').first()).toBeVisible(); await noOverflow('equipment at Hours');
 await eq('scale-days').click();
 await page().evaluate(() => { window.__opened = []; window.open = url => { window.__opened.push(String(url)); return null; }; });
 await eq('web').first().click(); expect(await page().evaluate(() => window.__opened)).toEqual(['https://app.example.invalid/resources/equipment']);

 // A conflict: the same reservation at the same revision with other details, read for another cell.
 await start(); await bootstrap(); await atLeast(3); await occupancy(); await answer('equipment-conflict-a');
 await expect(eq('bar-00000000-0000-4000-b000-000000000900').first()).toBeVisible({ timeout: 15_000 });
 await atLeast(4); await occupancy(); await answer('equipment-conflict-b');
 await expect(eq('problem')).toContainText('Captain received conflicting details for a reservation.', { timeout: 15_000 });
 await expect(eq('bar-00000000-0000-4000-b000-000000000900')).toHaveCount(0);
 const stopped = (await log()).length;
 await page().waitForTimeout(600); expect((await log()).length).toBe(stopped); // occupancy stopped until Refresh
 await eq('refresh').click(); await count(stopped + 1); expect((await last()).pathname).toMatch(orgPath);

 // Zone change on an occupancy answer, a failed cell with Try again, and a network failure's way out.
 await start(); await bootstrap(); await atLeast(3); await occupancy(); await answer('equipment-zone-perth');
 await expect(eq('problem')).toContainText('The business time zone changed. Refresh to see the schedule.', { timeout: 15_000 });
 await start(); await bootstrap(); await atLeast(3); await occupancy(); await answer('unavailable');
 await expect(eq('cells-try-again')).toBeVisible({ timeout: 15_000 });
 await expect(page().getByText("Captain couldn't read these dates.").first()).toBeVisible();
 const failedReads = (await log()).length; await page().waitForTimeout(600); expect((await log()).length).toBe(failedReads);
 await eq('cells-try-again').click(); await count(failedReads + 1); await occupancy(); await answer('equipment-ok');
 await expect(bar('Sample overnight brew')).toBeVisible({ timeout: 15_000 });

 // No-timeline states: empty, an unsupported zone, access refused, a failed bootstrap with Try again, and a wait.
 await start(); await bootstrap('equipment-ok', 'equipment-empty');
 await expect(eq('empty')).toContainText('No equipment is listed yet.'); await expect(eq('web')).toBeVisible();
 await start(); await answer('equipment-zone-bogus');
 await expect(eq('zone-unsupported')).toContainText("Times can't be shown in the business time zone on this device."); await expect(eq('refresh')).toBeEnabled();
 await count(1);
 await start(); await answer('refused-404');
 await expect(eq('bootstrap-failed')).toContainText("Captain couldn't read this organisation's equipment."); await expect(eq('try-again')).toHaveCount(0); await count(1);
 await start(); await answer('equipment-malformed');
 await expect(eq('bootstrap-failed')).toContainText("Couldn't load the schedule."); await eq('try-again').click(); await count(2);
 expect((await last()).pathname).toMatch(orgPath);
 await start(true); await answer('unavailable-wait'); await expect(eq('try-again')).toBeDisabled();
 await page().clock.runFor(4999); await expect(eq('try-again')).toBeDisabled(); await count(1);
 await page().clock.runFor(1); await expect(eq('try-again')).toBeEnabled(); await count(1);
 await page().clock.resume(); await eq('try-again').click(); await count(2);

 // More equipment: a full page 0 offers More; page 1 repeats two IDs, so the list-changed notice appears.
 await start(); await bootstrap('equipment-ok', 'equipment-more');
 await expect(eq('notice').filter({ hasText: 'More equipment not loaded yet' })).toBeVisible();
 await eq('more-offered').click(); await expect.poll(async () => (await log()).at(-1).path).toMatch(/offset=100$/);
 const moreReads = (await log()).length; await answer('equipment-more');
 await expect(eq('notice').filter({ hasText: 'The equipment list changed while loading.' })).toBeVisible({ timeout: 15_000 });
 expect((await log()).length).toBeGreaterThanOrEqual(moreReads);

 // Scope change: nothing from the old scope is shown or sent again.
 await start(); await bootstrap(); await expect(eq('zone')).toBeVisible();
 const epoch = (await log()).at(-1).epoch;
 await page().getByTestId('harness-transition-switch').click();
 await expect.poll(async () => (await log()).at(-1).epoch).not.toBe(epoch);
 await expect(page().getByText('Sample fermenter', { exact: true })).toHaveCount(0);
 console.log(`PASS ${width}px: Equipment schedule bootstrap order, one flight, never-free partial/conflict/failed cells, zone change, waits, More and stale scope suppression`);
};
