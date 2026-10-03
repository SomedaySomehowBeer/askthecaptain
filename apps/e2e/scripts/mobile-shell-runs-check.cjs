/** Runs of change lines (owner decision, 3 October 2026; versions contract §3) on the test-only harness export, whose
 *  synthetic threads are contract-shaped (apps/mobile/harness/thread-fixtures.ts): a run folds to one line and unfolds
 *  in place on tap; a message splits runs; the unread marker inside a run unfolds it; a system creation line is shown
 *  but is never the first unread. Times are read in Sydney so the first run crosses two days. Not hosted, not native,
 *  not assistive technology. */
const { expect } = require('@playwright/test'); const path = require('node:path');
module.exports = async ({ browser, base, shots, width }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, timezoneId: 'Australia/Sydney' });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const message = n => `00000000-0000-4000-8000-${String(500 + n).padStart(12, '0')}`, thread = '00000000-0000-4000-8000-000000000011';
  const id = n => page.getByTestId(n).filter({ visible: true });
  const open = async scenario => { await page.goto(new URL(`/threads/${thread}?scenario=${scenario}`, base).href); await expect(page.getByTestId('harness-scenario')).toHaveText(scenario); await expect(id('thread-card')).toBeVisible(); };
  const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-runs-${name}.png`), fullPage: true }); };
  // The folded line is one row inside the frame: wrapped, never clipped or pushed past the edge.
  const fits = async testId => { const box = await id(testId).boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5); expect(box.height).toBeGreaterThanOrEqual(44); };

  // A run of three across two days by Maya and Tom, a message, then a run of two by Tom: two folded lines.
  await open('threads-runs');
  const first = id(`change-run-${message(2)}`), second = id(`change-run-${message(6)}`);
  await expect(first).toHaveCount(1); await expect(second).toHaveCount(1);
  await expect(first).toContainText('Maya ticked the step Book the canning line and 2 earlier changes by Maya and Tom · Thu 1 Oct – Fri 2 Oct');
  await expect(second).toContainText('Tom changed the status from Open to In progress and 1 earlier change · ');
  await expect(second).not.toContainText(' by ');
  await expect(first).toHaveAttribute('role', 'button');
  expect(await first.getAttribute('aria-label')).toMatch(/and 2 earlier changes by Maya and Tom, Thu 1 Oct – Fri 2 Oct\. Show all 3 changes$/);
  expect(await second.getAttribute('aria-label')).toMatch(/\. Show all 2 changes$/);
  for (const n of [2, 3, 4, 6, 7]) await expect(page.getByTestId(`change-line-${message(n)}`)).toHaveCount(0);
  await expect(id('thread-unread-line')).toHaveCount(0);
  await fits(`change-run-${message(2)}`); await fits(`change-run-${message(6)}`); await overflow(); await shot('folded');
  // A tap unfolds that run in place, each line as today (a link to History); the other run stays folded.
  await first.click();
  await expect(page.getByTestId(`change-run-${message(2)}`)).toHaveCount(0);
  await expect(id(`change-line-${message(2)}`)).toContainText('Maya changed the due date from Tue 6 Oct to Thu 8 Oct');
  await expect(id(`change-line-${message(3)}`)).toContainText('Tom changed the owner from Maya Chen to Tom Reilly');
  await expect(id(`change-line-${message(4)}`)).toContainText('Maya ticked the step Book the canning line');
  for (const n of [2, 3, 4]) await expect(id(`change-line-${message(n)}`)).toHaveAttribute('role', 'link');
  const order = await page.locator('[data-testid^="change-line-"], [data-testid^="change-run-"]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')));
  expect(order).toEqual([2, 3, 4].map(n => `change-line-${message(n)}`).concat(`change-run-${message(6)}`));
  await expect(id(`change-run-${message(6)}`)).toHaveCount(1);
  await overflow(); await shot('unfolded');

  // The first unread is the run's second line: that run shows unfolded with the marker on that line.
  await open('threads-runs-unread');
  await expect(id('thread-unread-line')).toHaveCount(1);
  await expect(id(`message-${message(3)}`).getByTestId('thread-unread-line')).toHaveCount(1);
  await expect(page.getByTestId(`change-run-${message(2)}`)).toHaveCount(0);
  for (const n of [2, 3, 4]) await expect(id(`change-line-${message(n)}`)).toHaveCount(1);
  await expect(id(`change-run-${message(6)}`)).toHaveCount(1);
  const line = await id('thread-unread-line').boundingBox(), area = await id('thread-messages').boundingBox();
  expect(line.y).toBeGreaterThanOrEqual(area.y - 2); expect(line.y).toBeLessThan(area.y + area.height);
  await overflow(); await shot('unread-inside');

  // The system's creation of a series occurrence: shown, never the first unread; the marker is on Tom's message.
  await open('threads-system-created');
  await expect(id(`change-line-${message(1)}`)).toContainText('Captain created the task Excise return October and added the tag Production');
  await expect(id('thread-unread-line')).toHaveCount(1);
  await expect(id(`message-${message(2)}`).getByTestId('thread-unread-line')).toHaveCount(1);
  await expect(id(`message-${message(1)}`).getByTestId('thread-unread-line')).toHaveCount(0);
  await overflow(); await shot('system-created');

  expect(errors).toEqual([]);
  console.log(`PASS ${width}px: runs of change lines fold to one line with actors and dates, unfold on tap with their History links, split at a message; the unread marker inside a run unfolds it; a system creation line is never the first unread`);
 } finally { await context.close(); }
};
