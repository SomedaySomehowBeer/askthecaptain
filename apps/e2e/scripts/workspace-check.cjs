/** Run only against test/workspace-fixture.ts and a local production web build. No hosted writes. */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:3034';
const directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw new Error('Set WORKSPACE_PROBE_DIR to the temporary fixture directory.');
(async () => {
 const fixture = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(fixture.fixture, 'captain-workspace-local');
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 const errors = [];
 const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
 // The shared browser is in Docker; forwarding through Node reaches loopback-only local servers.
 if (process.env.CHROME_CDP_URL) await context.route(`${origin}/**`, async route => {
  const response = await route.fetch({ maxRedirects: 0 });
  const location = response.headers().location;
  // Chromium does not re-route the follow-up of a fulfilled HTTP redirect. A fresh navigation
  // keeps it on this loopback bridge. HTTP redirect statuses are also checked directly below.
  if (location && response.status() >= 300 && response.status() < 400 && route.request().isNavigationRequest()) {
   const destination = new URL(location, route.request().url()).href;
   await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination).replace(/</g, '\\u003c')})</script>` });
  } else await route.fulfill({ response });
 });
 const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
 // Pace full navigations: each server-rendered view checks the session and may read several resources.
 const goto = async route => { await new Promise(resolve => setTimeout(resolve, 1500)); return page.goto(origin + route); };
 const signIn = () => context.addCookies([{ name: 'captain_session', value: fixture.token, url: origin }]);
 const api = async (route, options = {}) => {
  for (let attempt = 0; attempt < 2; attempt++) {
   const response = await fetch('http://127.0.0.1:8084' + fixture.base + route, { ...options, headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' } });
   // Fixture setup respects the real limiter. Only 429 is retried: middleware rejects it before
   // any write. Transport failures and 5xx remain ambiguous and must fail, not repeat a write.
   if (response.status === 429 && attempt === 0) {
    const seconds = Number(response.headers.get('retry-after'));
    assert.ok(Number.isFinite(seconds) && seconds > 0 && seconds <= 60, 'bounded Retry-After');
    console.log(`Waiting ${seconds}s for the fixture API rate-limit window`);
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    continue;
   }
   assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  }
  throw new Error('Fixture request did not complete');
 };
 const mode = value => writeFile(path.join(directory, 'mode'), value);
 try {
  // A failed prior run may have committed its task; clear only this fixture's named test record.
  for (const task of (await api(`/tasks?ownerId=${fixture.userId}&status=open&limit=100`)).tasks)
   if (task.title === 'Browser-created task') await api(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
  for (const route of ['/work', '/work/new', '/work/views', '/work/tags', '/work/tasks/00000000-0000-4000-8000-000000000000/tags', '/chat', '/chat/views', '/resources', '/resources/views', '/resources/inventory', '/today']) {
   const response = await fetch(origin + route, { redirect: 'manual' }); assert.equal(response.status, 307);
   await goto(route); await expect(page).toHaveURL(/\/sign-in\?/);
  }
  console.log('PASS unauthenticated redirects before streaming');
  await signIn(); await goto('/'); await expect(page).toHaveURL(origin + '/work');
  await expect(page.getByRole('heading', { name: 'My work', exact: true })).toBeVisible();
  await expect(page.locator('.work-task')).toHaveCount(1);
  await expect(page.getByText('Confirm packaging slot', { exact: true })).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'phone overflow');
  await mkdir(path.join(directory, 'screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(directory, 'screenshots/work-phone.png'), fullPage: true });
  await page.getByText('Filter', { exact: true }).click();
  await page.getByLabel('Owner', { exact: true }).selectOption('all');
  await page.getByLabel('Sales', { exact: true }).check();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Call the stockist', { exact: true })).toBeVisible();
  await expect(page.locator('.work-task')).toHaveCount(1);
  const filteredUrl = page.url();
  await page.locator('.tabbar').getByRole('link', { name: 'Chat', exact: true }).click();
  await expect(page.getByText('Chat is not available yet.', { exact: false })).toBeVisible();
  await page.locator('.tabbar').getByRole('link', { name: 'Work', exact: true }).click();
  await expect(page).toHaveURL(filteredUrl);
  console.log('PASS real owner/tag filters and tab route restoration');
  await goto('/work?owner=all&status=done');
  await page.getByText('Completed launch task', { exact: true }).click();
  await expect(page.locator(`#task-${fixture.tasks['Completed launch task']}`)).toBeVisible();
  await goto('/work?owner=all&status=cancelled');
  await expect(page.getByText('Cancelled launch task', { exact: true })).toBeVisible();
  await expect(page.locator('a.work-task__link').filter({ hasText: 'Cancelled launch task' })).toHaveCount(0);
  console.log('PASS completed task reveal and honest cancelled row');
  await goto('/work?tagId=00000000-0000-4000-8000-000000000000&projectId=00000000-0000-4000-8000-000000000001');
  await page.getByText('Filter', { exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.ok(page.url().includes('tagId=00000000-0000-4000-8000-000000000000'));
  assert.ok(page.url().includes('projectId=00000000-0000-4000-8000-000000000001'));
  await goto('/work?offset=1000050'); await expect(page.getByText('These filters could not be read', { exact: false })).toBeVisible();
  await goto('/work?offset=50'); await expect(page.getByText('Nothing on this page', { exact: true })).toBeVisible();
  await mode('failed'); await goto('/work'); await expect(page.getByText('Work could not be read', { exact: true })).toBeVisible();
  await expect(page.getByText('Nothing open is assigned to you', { exact: true })).toHaveCount(0);
  await mode('');
  console.log('PASS missing lookup preservation, invalid, empty and failed reads');
  await goto('/work/new');
  await page.getByLabel('Task', { exact: true }).fill('Browser-created task');
  await page.getByLabel('Project', { exact: true }).selectOption(fixture.projectId);
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page).toHaveURL(/\/commitments#task-/);
  const created = (await api(`/tasks?ownerId=${fixture.userId}&status=open&limit=100`)).tasks.find(task => task.title === 'Browser-created task');
  assert.ok(created); assert.equal(created.ownerId, fixture.userId); assert.equal(created.projectId, fixture.projectId);
  await expect(page.locator(`#task-${created.id}`)).toBeVisible();
  console.log('PASS task creation persisted through authenticated API/RLS');
  await goto(`/work?owner=all&projectId=${fixture.projectId}`);
  await expect(page.locator('.work-task')).toHaveCount(50);
  await page.getByRole('link', { name: 'Next', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`owner=all.*projectId=${fixture.projectId}.*offset=50`));
  assert.ok(await page.locator('.work-task').count() > 0);
  await page.getByRole('link', { name: 'Previous', exact: true }).click();
  await expect(page.locator('.work-task')).toHaveCount(50);
  const remembered = page.url();
  await page.locator('.tabbar').getByRole('link', { name: 'Resources', exact: true }).click();
  await page.getByRole('link', { name: 'Resources views', exact: true }).click();
  await page.getByRole('link', { name: /Inventory Existing stock/ }).click();
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await expect(page.locator('.tabbar').getByRole('link', { name: 'Resources', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.locator('.tabbar').getByRole('link', { name: 'Work', exact: true }).click();
  await expect(page).toHaveURL(remembered);
  console.log('PASS bounded pagination and independent Inventory/Work tab state');
  for (const route of ['/work/views', '/chat/views', '/resources/views', '/resources', '/resources/inventory', '/today', '/inbox', '/calendar', '/notes', '/settings/connections', '/settings/contacts', '/settings/workflows', '/sign-in']) {
   await goto(route); await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} phone overflow`);
  }
  for (const route of ['/today', '/inbox', '/calendar', '/notes', '/inbox/00000000-0000-4000-8000-000000000000', '/notes/00000000-0000-4000-8000-000000000000']) {
   await goto(route); await expect(page.getByRole('heading', { name: 'This part of Captain has been retired' })).toBeVisible();
   await expect(page.locator('form')).toHaveCount(0);
  }
  await goto('/work/views');
  await expect(page.locator('a[href^="/today"], a[href^="/inbox"], a[href^="/calendar"], a[href^="/notes"]')).toHaveCount(0);
  await goto(`/settings/workflows?run=${fixture.retiredRun}`);
  await expect(page.getByText("This run's workflow version is no longer offered, so its steps are listed below as they ran.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await page.getByText('Every step as it ran', { exact: true }).click(); await expect(page.getByText('draftChaser', { exact: true })).toBeVisible();
  await goto('/settings/connections'); await expect(page.getByRole('button', { name: /Connect Google|Reconnect Google|Enable live/ })).toHaveCount(0);
  const person = await api('/contacts', { method: 'POST', body: JSON.stringify({ name: 'Resource contact', email: `resource-${Date.now()}@example.test` }) });
  await goto(`/settings/contacts/${person.id}`); await expect(page.getByRole('heading', { name: 'Resource contact', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Recent mail|Notes/ })).toHaveCount(0);
  await goto(`/inbox/contacts/${person.id}`); await expect(page).toHaveURL(origin + `/settings/contacts/${person.id}`);
  await goto('/work/views'); await page.screenshot({ path: path.join(directory, 'screenshots/work-views-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 }); await goto('/work');
  await expect(page.locator('.topnav').getByRole('link', { name: 'Resources', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(directory, 'screenshots/work-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const taskId = fixture.tasks['Confirm packaging slot'];
  const tagPath = `/work/tasks/${taskId}/tags`;
  await goto('/work');
  await page.getByRole('link', { name: 'Edit tags for Confirm packaging slot', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Confirm packaging slot', exact: true })).toBeVisible();
  await goto('/work/tags');
  const label = `Browser label ${Date.now()}`;
  await page.getByLabel('New tag', { exact: true }).fill(label);
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(page.locator('.work-tag-row__name').filter({ hasText: label })).toBeVisible();
  const createdTag = (await api('/tags?limit=100')).tags.find(tag => tag.name === label); assert.ok(createdTag);
  await page.getByLabel('New tag', { exact: true }).fill(label.toUpperCase());
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('already exists');
  await expect(page.getByLabel('New tag', { exact: true })).toHaveValue(label.toUpperCase());
  await goto(tagPath);
  await page.getByRole('button', { name: `Add ${label}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Remove ${label}`, exact: true })).toBeVisible();
  assert.equal((await api(`/tasks/${taskId}/tag-options?limit=100`)).tags.find(tag => tag.id === createdTag.id).attached, true);
  await goto(`/work?owner=all&tagId=${createdTag.id}`);
  await expect(page.getByText('Confirm packaging slot', { exact: true })).toBeVisible();
  await goto('/work/tags');
  const row = page.locator('.work-tag-row').filter({ has: page.getByText(label, { exact: true }) });
  await row.getByText('Rename', { exact: true }).click();
  const renamed = `${label} renamed`;
  await row.getByRole('textbox').fill(renamed);
  await row.getByRole('button', { name: 'Rename for everyone', exact: true }).click();
  await expect(page.locator('.work-tag-row__name').filter({ hasText: renamed })).toBeVisible();
  await goto(`/work?owner=all&tagId=${createdTag.id}`);
  await expect(page.locator('.work-task__tags')).toContainText(renamed);
  await goto(tagPath);
  await page.getByRole('button', { name: `Remove ${renamed}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Add ${renamed}`, exact: true })).toBeVisible();
  assert.equal((await api(`/tasks/${taskId}/tag-options?limit=100`)).tags.find(tag => tag.id === createdTag.id).attached, false);
  console.log('PASS shared tag create/duplicate/rename and persisted task add/remove');
  await mode('tag-write-failed');
  await page.getByRole('button', { name: `Add ${renamed}`, exact: true }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('could not confirm');
  await expect(page.getByRole('button', { name: `Add ${renamed}`, exact: true })).toBeVisible();
  await goto('/work/tags');
  await page.getByLabel('New tag', { exact: true }).fill('Unconfirmed label');
  await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('could not confirm');
  await expect(page.getByLabel('New tag', { exact: true })).toHaveValue('Unconfirmed label');
  await mode('tags-failed');
  for (const route of ['/work/tags', tagPath]) {
   await goto(route); await expect(page.getByText('Tags could not be read', { exact: true })).toBeVisible();
   await expect(page.getByText('No tags yet', { exact: true })).toHaveCount(0);
  }
  await mode('');
  await goto('/work/tasks/00000000-0000-4000-8000-000000000000/tags');
  await expect(page.getByText('This task cannot be tagged here', { exact: true })).toBeVisible();
  await goto('/work/tasks/not-a-task/tags');
  await expect(page.getByText('This link is not valid', { exact: true })).toBeVisible();
  await goto('/work/tags?offset=1000050');
  await expect(page.getByText('That page of tags does not exist', { exact: true })).toBeVisible();
  await goto(`${tagPath}?offset=1000000`);
  await expect(page.getByText('Nothing on this page', { exact: true })).toBeVisible();
  console.log('PASS tag failed-save input retention, confirmed link state and read/error boundaries');
  const existingNames = new Set((await api('/tags?limit=100')).tags.map(tag => tag.name));
  for (let i = 0; i < 51; i++) {
   const name = `Page label ${String(i).padStart(2, '0')}`;
   if (!existingNames.has(name)) await api('/tags', { method: 'POST', body: JSON.stringify({ name }) });
  }
  for (const route of ['/work/tags', tagPath]) {
   await goto(route);
   await page.getByRole('link', { name: 'Next', exact: true }).click();
   await expect(page).toHaveURL(origin + route + '?offset=50');
   await page.getByRole('link', { name: 'Previous', exact: true }).click();
   await expect(page).toHaveURL(origin + route);
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} phone overflow`);
  }
  await page.screenshot({ path: path.join(directory, 'screenshots/task-tags-phone.png'), fullPage: true });
  await goto('/work/tags'); await page.screenshot({ path: path.join(directory, 'screenshots/tags-phone.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 }); await goto(tagPath);
  await expect(page.getByRole('heading', { name: 'Confirm packaging slot', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(directory, 'screenshots/task-tags-desktop.png'), fullPage: true });
  console.log('PASS tag catalogue pagination and mobile/desktop layouts');
  assert.deepEqual(errors, []);
  console.log('PASS grouped routes, retired assistant routes, mobile/desktop layout and no browser exceptions');
 } catch (error) { await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); throw error; } finally { await mode(''); await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
