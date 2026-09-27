/** All tasks runs the production shared list with synthetic, controlled responses; no native proof. */
const { expect } = require('@playwright/test');
module.exports = async ({ getPage, freshPage, scenario, shot, noOverflow, width }) => {
 const page = () => getPage();
 const id = name => page().locator(`[data-testid="${name}"]:visible`);
 const all = suffix => id(`all-work-${suffix}`);
 const rows = () => page().locator('[data-testid^="all-work-row-"]:visible');
 const mineRows = () => page().locator('[data-testid^="work-row-"]:visible');
 const log = async () => JSON.parse(await page().getByTestId('work-read-log').textContent());
 const count = async n => expect.poll(async () => (await log()).length).toBe(n);
 const answer = async name => page().getByTestId(`harness-read-${name}`).click();
 const query = async offset => {
  const url = new URL((await log()).at(-1).path, 'https://example.invalid');
  expect([...url.searchParams.keys()]).toEqual(['status','offset','limit']);
  expect(url.searchParams.get('status')).toBe('open');
  expect(url.searchParams.get('offset')).toBe(String(offset)); expect(url.searchParams.get('limit')).toBe('50');
 };
 const start = async (freeze = false) => {
  await freshPage();
  if (freeze) { await page().clock.install(); await page().clock.pauseAt(await page().evaluate(() => Date.now())); }
  await scenario('ready', '/work/all');
  await expect(page().getByRole('heading', { name: 'All tasks', exact: true })).toBeVisible();
  await expect(all('subtitle')).toHaveText('Open tasks assigned to anyone'); await count(1); await query(0);
 };
 await start(); await expect(all('loading')).toBeVisible(); await answer('unavailable');
 await expect(page().getByText("Couldn't load open tasks", { exact: true })).toBeVisible();
 await expect(page().getByText('No open tasks in this organisation', { exact: true })).toHaveCount(0);
 await all('try-again').click(); await count(2); await query(0); await answer('empty');
 await expect(page().getByText('No open tasks in this organisation', { exact: true })).toBeVisible();
 await all('refresh').click(); await count(3); await answer('ok-page'); await expect(rows()).toHaveCount(50);
 await expect(rows().nth(0)).toContainText('Open · Assigned to you · Alpha · Bravo · Charlie · +2 more');
 await expect(rows().nth(1)).toContainText('Open · Assigned to someone else');
 await expect(rows().nth(2)).toContainText('Open · No owner');
 await expect(rows().getByRole('button')).toHaveCount(0); await expect(rows().getByRole('link')).toHaveCount(0);
 await noOverflow('All tasks'); await shot('all-tasks');
 await all('refresh').click(); await count(4); await answer('unavailable'); await expect(rows()).toHaveCount(50);
 await expect(page().getByText("Couldn't refresh. This list may be out of date.", { exact: true })).toBeVisible();
 await all('try-again').click(); await count(5); await query(0); await answer('ok-page');
 await all('more').click(); await count(6); await query(50); await answer('unavailable');
 await expect(rows()).toHaveCount(50); await all('try-again').click(); await count(7); await query(50); await answer('ok-last');
 await expect(rows()).toHaveCount(53); await expect(all('more')).toHaveCount(0); await expect(all('cap')).toHaveCount(0);
 await all('refresh').click(); await count(8); await query(0); await answer('ok-last'); await expect(rows()).toHaveCount(3);

 await start(); await answer('ok-page'); await expect(rows()).toHaveCount(50);
 for (let i = 1; i < 10; i++) {
  await all('more').click(); await count(i + 1); await query(i * 50); await answer('ok-overlap');
  await expect(rows()).toHaveCount(25 + i * 50);
 }
 await expect(rows()).toHaveCount(475); await expect(all('more')).toHaveCount(0);
 await expect(all('cap')).toContainText('Some more open tasks may be available on the Captain website.');
 await page().evaluate(() => { window.__opened = []; window.open = url => { window.__opened.push(String(url)); return null; }; });
 await all('web').click(); expect(await page().evaluate(() => window.__opened)).toEqual(['https://app.example.invalid/work?owner=all']);
 await page().getByRole('tab', { name: 'Chat', exact: true }).click();
 await page().getByRole('tab', { name: 'Work', exact: true }).click(); await expect(rows()).toHaveCount(475); await count(10);

 await start(true); await answer('ok-page'); await all('more').click(); await count(2); await answer('unavailable-wait');
 for (const name of ['more','refresh','try-again']) await expect(all(name)).toBeDisabled();
 await all('try-again').dispatchEvent('click'); await count(2);
 await page().clock.runFor(4999); await expect(all('try-again')).toBeDisabled();
 await page().clock.runFor(1); await expect(all('try-again')).toBeEnabled(); await count(2);
 await page().clock.resume(); await all('try-again').click(); await count(3); await query(50); await answer('ok-last'); await expect(rows()).toHaveCount(53);
 await start(); await answer('refused-404');
 await expect(page().getByText("Captain couldn't read this organisation's work. If your access has changed, Captain will show it the next time it checks.", { exact: true })).toBeVisible(); await count(1);

 // Both lists really mounted on this browser path. Every old instance must become inert on scope change.
 for (const transition of ['switch','lost-single']) {
  await freshPage(); await scenario('ready'); await count(1); await answer('ok-page'); await expect(mineRows()).toHaveCount(50);
  await page().getByRole('button', { name: 'Work views', exact: true }).click();
  await page().getByRole('link', { name: 'All tasks. Open tasks assigned to anyone', exact: true }).click();
  await count(2); await query(0); await answer('ok-page'); await expect(rows()).toHaveCount(50);
  await all('more').click(); await count(3); await query(50);
  const oldEpoch = (await log()).at(-1).epoch;
  await page().getByTestId(`harness-transition-${transition}`).click(); await count(4);
  await expect(rows()).toHaveCount(0); await expect(id('work-loading')).toBeVisible(); await expect(mineRows()).toHaveCount(0);
  const last = (await log()).at(-1); expect(last.epoch).not.toBe(oldEpoch);
  const url = new URL(last.path, 'https://example.invalid'); expect(url.searchParams.has('ownerId')).toBe(true); expect(url.searchParams.get('offset')).toBe('0');
  await answer('ok-page'); await expect(mineRows()).toHaveCount(0); await count(4);
  await answer('ok-last'); await expect(mineRows()).toHaveCount(3); await count(4);
 }
 // A view-list round trip mounts a new route; it must issue one new page-zero read, never share the hidden list.
 await freshPage(); await scenario('ready'); await count(1); await answer('ok-last'); await expect(mineRows()).toHaveCount(3);
 const views = async () => page().getByRole('button', { name: 'Work views', exact: true }).click();
 const openAll = async () => page().getByRole('link', { name: 'All tasks. Open tasks assigned to anyone', exact: true }).click();
 await views(); await openAll(); await count(2); await answer('ok-last'); await expect(rows()).toHaveCount(3);
 await views(); await page().getByRole('link', { name: 'My work. Assigned to you, across all tags', exact: true }).click();
 await count(3); expect(new URL((await log()).at(-1).path, 'https://example.invalid').searchParams.get('offset')).toBe('0');
 await answer('empty'); await expect(mineRows()).toHaveCount(0);
 await views(); await openAll(); await count(4); await query(0); await answer('empty'); await expect(rows()).toHaveCount(0);

 await freshPage(); await scenario('checking', '/work/all'); await page().getByTestId('harness-transition-verify').click();
 await expect(page().getByRole('heading', { name: 'All tasks', exact: true })).toBeVisible(); await count(1); await query(0);
 await freshPage(); await scenario('signed-out', '/work/all'); await page().getByRole('button', { name: 'Sign in with Google', exact: true }).click();
 await expect.poll(async () => JSON.parse(await page().getByTestId('account-command-log').textContent())).toEqual([{ type: 'sign-in', returnTo: '/work/all' }]);
 console.log(`PASS ${width}px: All tasks owner facts, paging/retry/cap, fixed links, scope loss, independent mounts and guarded deep links`);
};
