/** By tag contract (#158). Local production web + disposable workspace-fixture API/Postgres only.
 * Use WORKSPACE_PROBE_FAST_LIMITS=1 to isolate UI checks from burst-rate windows; auth/RLS/writes are real. */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:3034', directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw Error('WORKSPACE_PROBE_DIR required');
(async () => {
 const f = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(f.fixture, 'captain-workspace-local'); assert.equal(f.fastRateWindows, true);
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
 if (process.env.CHROME_CDP_URL) await context.route(`${origin}/**`, async route => {
  const response = await route.fetch({ maxRedirects: 0 }), location = response.headers().location;
  if (location && response.status() >= 300 && response.status() < 400 && route.request().isNavigationRequest()) {
   const destination = new URL(location, route.request().url()).href;
   await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination).replace(/</g, '\\u003c')})</script>` });
  } else await route.fulfill({ response });
 });
 await context.addCookies([{ name: 'captain_session', value: f.token, url: origin }, { name: 'captain_organisation', value: f.orgId, url: origin }]);
 const page = await context.newPage(), errors = [];
 page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
 const goto = route => page.goto(origin + route);
 const mode = value => writeFile(path.join(directory, 'mode'), value);
 const api = async (route, method = 'GET', body, token = f.token, base = f.base) => {
  const r = await fetch('http://127.0.0.1:8084' + base + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(r.ok, `${method} ${route}: ${r.status}`); return r.json();
 };
 const tags = page.getByRole('region', { name: 'By tag', exact: true }), saved = page.getByRole('region', { name: 'Saved views', exact: true });
 const heading = name => expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
 const screenshot = async name => { await page.bringToFront(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow'); await page.screenshot({ path: path.join(directory, name), fullPage: true, timeout: 30000 }); };
 try {
  await mode('');
  await goto('/work/views');
  await expect(tags.getByRole('link', { name: /^Production Everyone/ })).toHaveAttribute('href', `/work?owner=all&tagId=${f.productionId}`);
  assert.deepEqual(await tags.locator('strong').allTextContents(), ['Production', 'Sales']);
  await tags.getByRole('link', { name: /^Production Everyone/ }).click(); await heading('Production');
  await expect(page.getByText('Confirm packaging slot', { exact: true })).toBeVisible();
  await expect(page.getByText('Call the stockist', { exact: true })).toHaveCount(0);
  await goto(`/work?owner=all&tagId=${f.productionId}&offset=50`); await heading('Production');
  await goto('/work'); await heading('My work');
  console.log('PASS existing tags link by ID to everyone/open; title survives task paging; My work unchanged');

  await goto('/work/tags');
  const productionRow = page.locator('.work-tag-row').filter({ has: page.getByText('Production', { exact: true }) });
  await productionRow.getByText('Rename', { exact: true }).click();
  await productionRow.getByRole('textbox').fill('Brewing');
  await productionRow.getByRole('button', { name: 'Rename for everyone', exact: true }).click();
  await expect(page.getByText('Brewing', { exact: true })).toBeVisible();
  await page.getByLabel('New tag', { exact: true }).fill('Marketing');
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(page.getByText('Marketing', { exact: true })).toBeVisible();
  await goto('/work/views'); await expect(tags.getByRole('link', { name: /^Brewing Everyone/ })).toHaveAttribute('href', `/work?owner=all&tagId=${f.productionId}`);
  await expect(tags.getByRole('link', { name: /^Marketing Everyone/ })).toBeVisible();
  await tags.getByRole('link', { name: /^Brewing Everyone/ }).click(); await heading('Brewing');
  await expect(page.getByText('Confirm packaging slot', { exact: true })).toBeVisible();
  console.log('PASS tag rename preserves navigation identity and tasks; new tags appear without view setup');

  await page.locator('summary').filter({ hasText: /^Save this view$/ }).click();
  await page.getByLabel('View name', { exact: true }).fill('Brew team');
  await page.getByLabel('View name', { exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/work\?view=[0-9a-f-]+$/); await heading('Brew team');
  const viewId = new URL(page.url()).searchParams.get('view');
  assert.equal((await api(`/views/${viewId}`)).filter.tagIds[0], f.productionId);
  assert.ok(!(await api('/views?limit=50', 'GET', undefined, f.memberToken)).views.some(v => v.id === viewId));
  await page.locator('.work-filters > details > summary').click(); await page.getByLabel('Status', { exact: true }).selectOption('done');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page).toHaveURL(/draft=1/); await heading('Brew team');
  await goto(`/work?owner=all&status=done&tagId=${f.productionId}`); await heading('All tasks');
  console.log('PASS saved personal copy stays private; saved/draft names and ordinary filter changes preserved');

  // Real tags/API calls; the explicit test limiter clock prevents the bulk fixture setup consuming UI windows.
  const longName = 'A'.repeat(60); await api('/tags', 'POST', { name: longName });
  for (let i = 0; i < 105; i++) await api('/tags', 'POST', { name: `Pagination ${String(i).padStart(3, '0')}` });
  const late = await api('/tags', 'POST', { name: 'ZZ Last tag' });
  await api(`/tasks/${f.tasks['Confirm packaging slot']}/tags/${late.id}`, 'PUT');
  await goto('/work/views?offset=50&tagOffset=50');
  await expect(tags.locator('.view-row')).toHaveCount(50);
  await expect(tags.getByRole('link', { name: 'Next', exact: true })).toHaveAttribute('href', '/work/views?offset=50&tagOffset=100');
  await tags.getByRole('link', { name: 'Next', exact: true }).click();
  await expect(saved.getByRole('link', { name: 'Previous', exact: true })).toHaveAttribute('href', '/work/views?tagOffset=100');
  await saved.getByRole('link', { name: 'Previous', exact: true }).click();
  await expect(tags.getByRole('link', { name: /^ZZ Last tag Everyone/ })).toBeVisible();
  await tags.getByRole('link', { name: /^ZZ Last tag Everyone/ }).click(); await heading('All tasks');
  await expect(page.getByText('Confirm packaging slot', { exact: true })).toBeVisible();
  await expect(page.locator('.work-task')).toHaveCount(1);
  console.log('PASS independent group pagination and exact filtering beyond the 100-tag heading lookup');

  await goto('/work/views?offset=50&tagOffset=bad');
  await expect(tags.getByText('That page of tags does not exist', { exact: true })).toBeVisible();
  await expect(tags.getByRole('link', { name: 'Show the first page of tags', exact: true })).toHaveAttribute('href', '/work/views?offset=50');
  await goto('/work/views?offset=bad&tagOffset=50');
  await expect(saved.getByRole('link', { name: 'Show the first page', exact: true })).toHaveAttribute('href', '/work/views?tagOffset=50');
  await expect(tags.locator('.view-row')).toHaveCount(50);
  await mode('tags-failed'); await goto('/work/views?offset=50&tagOffset=50');
  await expect(tags.getByText('Tags could not be read', { exact: true })).toBeVisible();
  await expect(tags.getByRole('link', { name: 'Try again', exact: true })).toHaveAttribute('href', '/work/views?offset=50&tagOffset=50');
  await expect(page.getByRole('link', { name: /^My work/ })).toBeVisible();
  await goto(`/work?owner=all&tagId=${f.productionId}`); await heading('All tasks');
  await expect(page.locator('.work-task')).toHaveCount(1);
  await mode('views-list-failed'); await goto('/work/views?offset=50&tagOffset=50');
  await expect(saved.getByRole('link', { name: 'Try again', exact: true })).toHaveAttribute('href', '/work/views?offset=50&tagOffset=50');
  await expect(tags.locator('.view-row')).toHaveCount(50); await mode('');
  console.log('PASS malformed cursors and independent failed reads preserve available groups and selected IDs');

  const longTag = (await api('/tags?limit=50')).tags.find(t => t.name === longName); assert.ok(longTag);
  for (const width of [360, 390, 430, 1440]) {
   await page.setViewportSize({ width, height: 900 }); await goto('/work/views');
   await screenshot(`tag-views-${width}.png`);
   await goto(`/work?owner=all&tagId=${longTag.id}`); await heading(longName);
   await screenshot(`tag-heading-${width}.png`);
  }
  console.log('PASS populated phone/desktop layouts including a 60-character name');

  const empty = await api('', 'POST', { name: 'Empty tag-navigation fixture' }, f.token, '/v1/organisations');
  await context.addCookies([{ name: 'captain_organisation', value: empty.id, url: origin }]);
  await goto('/work/views'); await expect(tags.getByText('No tags yet', { exact: true })).toBeVisible();
  await expect(tags.getByRole('link', { name: 'Open Tags', exact: true })).toBeVisible();
  assert.equal((await api('/tags?limit=50', 'GET', undefined, f.token, `/v1/organisations/${empty.id}`)).tags.length, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS new organisation empty state performs no seeding; no browser exceptions');
 } finally { await mode(''); await context.close(); await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
