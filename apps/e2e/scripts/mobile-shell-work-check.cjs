/** Synthetic My work proof through the production hook/screen and parser, never a live account or native proof. */
const { expect } = require('@playwright/test');
module.exports = async function workChecks({ getPage, freshPage, scenario, shot, noOverflow, width }) {
 const page = () => getPage();
 const id = name => page().getByTestId(name);
 const rows = () => page().getByRole('listitem');
 const log = async () => JSON.parse(await id('work-read-log').textContent());
 const count = async n => expect.poll(async () => (await log()).length).toBe(n);
 const answer = async name => id(`harness-read-${name}`).click();
 const offset = async (n, organisation) => {
  const last = (await log()).at(-1); const url = new URL(last.path, 'https://example.invalid');
  expect(url.searchParams.get('offset')).toBe(String(n));
  expect(url.searchParams.get('limit')).toBe('50'); expect(url.searchParams.get('status')).toBe('open');
  expect(url.searchParams.get('ownerId')).toMatch(/^[0-9a-f-]{36}$/);
  if (organisation) expect(url.pathname).toContain(organisation);
 };
 const start = async (freeze = false) => {
  await freshPage();
  if (freeze) { await page().clock.install(); await page().clock.pauseAt(await page().evaluate(() => Date.now())); }
  await scenario('ready');
  await expect(id('work-subtitle')).toHaveText('Open tasks assigned to you');
  await count(1); await offset(0);
 };
 await start();
 await expect(id('work-loading')).toBeVisible(); await expect(rows()).toHaveCount(0);
 await expect(page().getByText('Nothing open is assigned to you', { exact: true })).toHaveCount(0);
 await answer('unavailable');
 await expect(page().getByText("Couldn't load your work", { exact: true })).toBeVisible();
 await expect(page().getByText('Nothing open is assigned to you', { exact: true })).toHaveCount(0);
 await id('work-try-again').click(); await count(2); await offset(0); await answer('empty');
 await expect(page().getByText('Nothing open is assigned to you', { exact: true })).toBeVisible();
 await expect(rows()).toHaveCount(0); await expect(id('work-more')).toHaveCount(0);
 await shot('work-empty');
 await id('work-refresh').click(); await count(3); await answer('ok-page');
 await expect(rows()).toHaveCount(50);
 const first = rows().first();
 await expect(first).toContainText('Sample task AA');
 await expect(first).toContainText('Open · Alpha · Bravo · Charlie · +2 more');
 await expect(first).toContainText('Due 3 Oct 2026');
 const long = 'Sample long title ' + 'word '.repeat(81);
 await expect(rows().nth(1)).toContainText(Array.from(long).slice(0,299).join('') + '…');
 await expect(rows().nth(2)).toContainText('Untitled task');
 await expect(rows().getByRole('button')).toHaveCount(0); await expect(rows().getByRole('link')).toHaveCount(0);
 await noOverflow('populated My work'); await shot('work-populated');
 await id('work-refresh').click(); await count(4); await answer('unavailable');
 await expect(page().getByText("Couldn't refresh. This list may be out of date.", { exact: true })).toBeVisible();
 await expect(rows()).toHaveCount(50); await id('work-try-again').click(); await count(5); await offset(0); await answer('ok-page');
 await id('work-more').click(); await count(6); await offset(50); await answer('unavailable');
 await expect(page().getByText("Couldn't load more", { exact: true })).toBeVisible(); await expect(rows()).toHaveCount(50);
 await id('work-try-again').click(); await count(7); await offset(50); await answer('ok-overlap');
 await expect(rows()).toHaveCount(75);
 // Eight further pages reach the page cap with fewer than 500 distinct rows: no invented total.
 for (let index = 2; index < 10; index++) {
  await id('work-more').click(); await count(index + 6); await offset(index * 50); await answer('ok-overlap');
  await expect(rows()).toHaveCount(75 + (index - 1) * 50);
 }
 await expect(id('work-cap')).toContainText('Some more open tasks may be available on the Captain website.');
 await expect(rows()).toHaveCount(475); await expect(id('work-more')).toHaveCount(0);
 await page().evaluate(() => { window.__opened = []; window.open = url => { window.__opened.push(String(url)); return null; }; });
 await id('work-web').click(); expect(await page().evaluate(() => window.__opened)).toEqual(['https://app.example.invalid/work']);
 const beforeTab = (await log()).length;
 await page().getByRole('tab', { name: 'Chat', exact: true }).click();
 await page().getByRole('tab', { name: 'Work', exact: true }).click();
 await expect(rows()).toHaveCount(475); await count(beforeTab);
 await page().evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
 await page().waitForTimeout(100); await count(beforeTab);
 await id('work-refresh').click(); await count(beforeTab + 1); await offset(0); await answer('ok-last');
 await expect(rows()).toHaveCount(3); await expect(id('work-cap')).toHaveCount(0); await expect(id('work-more')).toHaveCount(0);

 // The read's own wait disables every read control, wakes exactly at the deadline and never sends automatically.
 await start(true); await answer('ok-page'); await expect(rows()).toHaveCount(50);
 await id('work-more').click(); await count(2); await answer('unavailable-wait');
 for (const name of ['work-refresh','work-more','work-try-again']) await expect(id(name)).toBeDisabled();
 await expect(page().getByRole('button', { name: 'Account and settings', exact: true })).toBeEnabled();
 await id('work-try-again').dispatchEvent('click'); await count(2);
 await page().clock.runFor(4999); await expect(id('work-try-again')).toBeDisabled(); await count(2);
 await page().clock.runFor(1); await expect(id('work-try-again')).toBeEnabled(); await count(2);
 await page().clock.runFor(2000); await count(2); await page().clock.resume();
 await id('work-try-again').click(); await count(3); await offset(50); await answer('ok-last'); await expect(rows()).toHaveCount(53);

 for (const control of ['refused-404','refused-400','client-bug']) {
  await start(); await answer(control);
  await expect(page().getByText(control === 'refused-404' ? "Captain couldn't read this organisation's work. If your access has changed, Captain will show it the next time it checks." : "Captain couldn't read this list.", { exact: true })).toBeVisible();
  await expect(rows()).toHaveCount(0); await expect(id('work-try-again')).toBeVisible(); await count(1);
 }
 await start(); await answer('unauthorised'); await expect(rows()).toHaveCount(0); await count(1);
 // The harness's 401 only tests dropping data; real session release is exercised by runner tests.
 // A delayed page from the old organisation cannot populate its successor or carry an offset into the new scope.
 for (const transition of ['switch','lost-single']) {
  await start(); await answer('ok-page'); await expect(rows()).toHaveCount(50);
  await id('work-more').click(); await count(2); await offset(50);
  const oldEpoch = (await log())[0].epoch;
  await id(`harness-transition-${transition}`).click(); await count(3);
  await expect(rows()).toHaveCount(0); await expect(id('work-loading')).toBeVisible();
  const next = (await log())[2]; expect(next.epoch).not.toBe(oldEpoch); await offset(0);
  expect(next.path.split('/tasks')[0]).not.toBe((await log())[0].path.split('/tasks')[0]);
  await answer('ok-page'); // Old More resolves superseded, leaving the new first read pending.
  await expect(rows()).toHaveCount(0); await expect(id('work-loading')).toBeVisible(); await count(3);
  await answer('ok-last'); await expect(rows()).toHaveCount(3); await count(3);
  await noOverflow('organisation changed');
 }
 await start(); await answer('ok-page'); await expect(rows()).toHaveCount(50);
 await id('work-more').click(); await count(2); await id('harness-transition-release').click();
 await expect(page().getByRole('tablist')).toHaveCount(0); await answer('ok-page'); await expect(rows()).toHaveCount(0); await count(2);
 console.log(`PASS ${width}px: My work loading, empty, real parser, paging/deduplication/cap, explicit refresh, exact retry wait, errors and stale scope suppression`);
};
