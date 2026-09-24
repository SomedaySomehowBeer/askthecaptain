// Local review attaches to the shared browser; CI opts into its own headless browser explicitly.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../../../apps/e2e/package.json', import.meta.url));
const { chromium } = require('@playwright/test');
const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const output = process.env.PROOF_EVIDENCE_DIR || path.join(root, 'evidence');
await fs.mkdir(output, { recursive: true });
const headless = process.argv.includes('--headless');
const browser = headless ? await chromium.launch() :
  await chromium.connectOverCDP(process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222');
const page = headless ? await browser.newPage() : await browser.contexts()[0].newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('http://captain-proof.test/**', async route => {
  const url = new URL(route.request().url());
  const file = path.resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist + path.sep)) return route.fulfill({ status: 403, body: 'Forbidden' });
  try {
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html';
    await route.fulfill({ body: await fs.readFile(file), contentType });
  } catch { await route.fulfill({ status: 404, body: 'Not found' }); }
});
const button = name => page.getByRole('button', { name, exact: true });
const readOffset = () => page.getByTestId('time-scroll').evaluate(el => el.scrollTop);
try {
  await page.bringToFront();
  for (const width of [390, 1280]) {
    const viewportHeight = width < 1000 ? 874 : 960;
    await page.setViewportSize({ width, height: viewportHeight });
    await page.goto('http://captain-proof.test/');
    await page.getByTestId('timeline-panel').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow');
    const long = page.getByTestId('booking-fermentation');
    const days = await long.boundingBox();
    await button('Weeks').click();
    const weeks = await long.boundingBox();
    assert.ok(Math.abs(days.height / weeks.height - 84 / 18) < 0.01, 'continuous duration scaling');
    assert.equal(await page.getByTestId('conflict-marker').count(), 1, 'conflict visible at week scale');
    await button('Days').click();
    await page.getByTestId('time-scroll').evaluate(el => { el.scrollTop = 650; });
    await page.waitForTimeout(100);
    const before = await readOffset();
    const height = await page.getByTestId('time-scroll').evaluate(el => el.clientHeight);
    await button('Hours').click();
    await page.waitForTimeout(100);
    assert.ok(Math.abs((await readOffset() + height / 2) / (52 * 24) - (before + height / 2) / 84) < 0.01, 'zoom anchor');
    await button('Inspect conflict').click();
    await page.getByTestId('booking-detail').getByText('Summer lager · unconfirmed', { exact: true }).waitFor();
    await button('Days').click();
    assert.ok((await page.getByTestId('booking-detail').textContent()).includes('Unconfirmed request'), 'selection retained');
    await button('Equipment →').click();
    assert.ok(await page.getByTestId('equipment-scroll').evaluate(el => el.scrollLeft > 0), 'horizontal resources');
    await page.screenshot({ path: path.join(output, `timeline-${width}.png`) });
    if (width < 1000) await button('Chat').click();
    await page.getByTestId('chat-panel').waitFor();
    await page.getByRole('textbox', { name: 'Message draft' }).fill('Preserve this draft.');
    if (width < 1000) {
      await button('Timeline').click(); await button('Chat').click();
      assert.equal(await page.getByRole('textbox', { name: 'Message draft' }).inputValue(), 'Preserve this draft.');
    }
    await page.getByTestId('message-list').evaluate(el => { el.scrollTop = 0; });
    await button('Load older messages').click();
    await page.getByTestId('message-list').evaluate(el => { el.scrollTop = 0; });
    await page.getByTestId('chat-message-101').waitFor();
    await button('Latest messages').click();
    await button('On the task').click();
    assert.equal(await page.getByTestId('inline-chat').locator('[data-testid^="chat-message-"]').count(), 6);
    assert.ok((await page.getByTestId('shared-pins').textContent()).includes('message-3'), 'older shared pin');
    const rows = page.getByTestId('inline-chat').locator('[data-testid^="chat-message-"]');
    assert.equal(await rows.first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(255, 255, 255, 0.35)');
    await page.screenshot({ path: path.join(output, `inline-chat-${width}.png`) });
    await button('Full chat').click();
    await page.getByRole('textbox', { name: 'Message draft' }).fill('Check the afternoon slot.');
    await button('Add local message').click();
    await page.getByTestId('chat-notice').getByText(/Added in this preview only/).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Message draft' }).inputValue(), '');
    await button('On the task').click();
    await page.getByTestId('inline-chat').getByText('Check the afternoon slot.', { exact: true }).waitFor();
    await button('Full chat').click();
    const composer = await page.getByTestId('composer').boundingBox();
    assert.ok(composer.y + composer.height <= viewportHeight + 1, 'composer within viewport');
    await page.screenshot({ path: path.join(output, `chat-${width}.png`) });
    for (const state of ['Loading', 'Empty', 'Failed', 'Disabled']) {
      await button(state).click();
      assert.equal(await page.getByTestId('timeline-panel').count(), 0);
      assert.equal(await page.getByTestId('chat-panel').count(), 0);
      if (state === 'Failed') { await button('Try again').click(); await page.getByTestId('chat-panel').waitFor({ state: 'attached' }); }
    }
    await button('Ready').click();
    console.log(`PASS ${width}px: continuous intervals, zoom anchor, conflict/selection, horizontal equipment, shared pins/latest six, history paging, retained drafts, local composition and unavailable states`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS no page errors. Browser proof only; native hardware and software keyboards unverified.');
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally { await page.close(); await browser.close(); }
