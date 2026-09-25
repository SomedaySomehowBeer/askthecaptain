/** Local production web + workspace-fixture only. Exercises the nullable-project handoff. */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:3034', directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw Error('WORKSPACE_PROBE_DIR required');
(async () => {
 const fixture = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(fixture.fixture, 'captain-workspace-local');
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
 if (process.env.CHROME_CDP_URL) await context.route(`${origin}/**`, async route => {
  const response = await route.fetch({ maxRedirects: 0 }), location = response.headers().location;
  if (location && response.status() >= 300 && response.status() < 400 && route.request().isNavigationRequest()) {
   const destination = new URL(location, route.request().url()).href;
   await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination).replace(/</g, '\\u003c')})</script>` });
  } else await route.fulfill({ response });
 });
 const page = await context.newPage(), errors = []; page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
 const goto = async route => { await new Promise(resolve => setTimeout(resolve, 1500)); return page.goto(origin + route); };
 const api = async (route, method = 'GET', body) => {
  const response = await fetch('http://127.0.0.1:8084' + fixture.base + route, { method, headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`); return response.json();
 };
 try {
  await writeFile(path.join(directory, 'mode'), '');
  await context.addCookies([{ name: 'captain_session', value: fixture.token, url: origin }]);
  const title = `Standalone browser work ${Date.now()}`;
  await goto('/work/new'); await expect(page.getByLabel('Project', { exact: true })).toHaveValue('');
  await page.getByLabel('Task', { exact: true }).fill(title); await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page).toHaveURL(/\/commitments#task-/);
  const taskId = page.url().split('#task-')[1];
  const standalone = page.getByRole('region', { name: 'Without a project', exact: true });
  await expect(standalone.locator(`#task-${taskId}`)).toBeVisible();
  assert.equal((await api(`/tasks?ownerId=${fixture.userId}&status=open&limit=100`)).tasks.find(t => t.id === taskId).projectId, null);
  assert.equal((await api('/commitments')).projects.some(p => p.name === 'Obligations'), false);
  await goto(`/work/tasks/${taskId}/tags`); await page.getByRole('button', { name: 'Add Production', exact: true }).click();
  await goto(`/work?tagId=${fixture.productionId}`); await expect(page.getByText(title, { exact: true })).toBeVisible();
  await page.getByText(title, { exact: true }).click(); await expect(page.locator(`#task-${taskId}`)).toBeVisible();
  await page.locator(`#task-${taskId}`).getByRole('button', { name: `Mark "${title}" done`, exact: true }).click();
  await expect(page.locator(`#task-${taskId}`)).toHaveClass(/task--done/);
  console.log('PASS standalone creation, Work tag filter, detail anchor and completion');
  await standalone.locator('summary').filter({ hasText: /^Add recurring work$/ }).click();
  const form = standalone.locator('form').filter({ has: page.getByLabel('First period starts') });
  const seriesTitle = `Recurring inspection ${Date.now()}`;
  await form.getByLabel('Title', { exact: true }).fill(seriesTitle);
  await form.getByLabel('First period starts').fill('2020-01-01');
  await expect(form.getByLabel('Project', { exact: true })).toHaveValue('');
  await form.getByRole('button', { name: 'Add recurring work', exact: true }).click();
  await expect(standalone.locator('.line').filter({ hasText: seriesTitle })).toBeVisible();
  const overview = await api('/commitments');
  const series = overview.series.find(s => s.title === seriesTitle); assert.equal(series.projectId, null);
  assert.ok(overview.tasks.some(t => t.seriesId === series.id && t.projectId === null));
  const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(n => n.id)); assert.equal(ids.length, new Set(ids).size, 'unique form and task IDs');
  console.log('PASS standalone recurrence materialisation and unique form labels');
  await goto(`/resources/equipment/new?equipmentId=${fixture.equipment[2].id}&date=2030-10-10`);
  await expect(page.getByLabel('Project (optional)', { exact: true })).toHaveValue('');
  await page.getByLabel('Task (optional)', { exact: true }).selectOption(taskId);
  await page.getByLabel('Title', { exact: true }).fill('Standalone task booking');
  await page.getByLabel('Starts', { exact: true }).fill('2030-10-10T09:00');
  await page.getByLabel('Ends', { exact: true }).fill('2030-10-10T10:00');
  await page.getByRole('button', { name: 'Reserve', exact: true }).click();
  await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]+$/);
  const bookingId = page.url().split('/').pop();
  const route = `/equipment/${fixture.equipment[2].id}/reservations/${bookingId}`;
  assert.equal((await api(route)).projectId, null);
  await api(`/tasks/${taskId}`, 'PATCH', { projectId: fixture.projectId });
  await page.getByLabel('Title', { exact: true }).fill('Stale booking edit');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText(/This changed since you opened it/)).toBeVisible();
  assert.equal((await api(route)).projectId, fixture.projectId);
  await goto(`/resources/equipment/${fixture.equipment[2].id}/reservations/${bookingId}`);
  await expect(page.getByLabel('Project (optional)', { exact: true })).toHaveValue(fixture.projectId);
  await expect(page.getByLabel('Task (optional)', { exact: true })).toHaveValue(taskId);
  await mkdir(path.join(directory, 'screenshots'), { recursive: true });
  for (const width of [390, 1440]) {
   await page.setViewportSize({ width, height: 900 });
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
   await page.screenshot({ path: path.join(directory, `screenshots/optional-booking-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []); console.log('PASS standalone equipment link, task move, stale booking refusal and responsive form');
 } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
