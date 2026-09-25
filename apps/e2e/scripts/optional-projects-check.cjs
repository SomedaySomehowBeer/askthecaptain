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
  await expect(page).toHaveURL(/\/work\/tasks\/[0-9a-f-]+$/);
  const taskId = page.url().split('/').pop(), taskPath=`/work/tasks/${taskId}`;
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  assert.equal((await api(`/tasks/${taskId}`)).task.projectId,null);
  assert.equal((await api('/projects')).projects.some(p=>p.name==='Obligations'),false);
  await goto(`/work/tasks/${taskId}/tags`);
  if(await page.getByRole('button',{name:'Add Production',exact:true}).count()===0)await page.getByRole('link',{name:'Next',exact:true}).click();
  await page.getByRole('button', { name: 'Add Production', exact: true }).click();
  await expect(page.getByRole('button',{name:'Remove Production',exact:true})).toBeVisible();
  await goto(`/work?tagId=${fixture.productionId}`); await page.getByText(title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(taskPath));
  await page.locator('summary').filter({hasText:/^Add checklist item$/}).click();
  await page.getByLabel('Checklist item',{exact:true}).fill('Count cases');await page.getByRole('button',{name:'Add checklist item',exact:true}).click();
  await expect(page.getByRole('link',{name:/Count cases/})).toBeVisible();
  await page.locator('summary').filter({hasText:/^Add evidence$/}).click();
  await page.getByLabel('Source link',{exact:true}).fill('https://example.test/packing-list');await page.getByLabel('Label',{exact:true}).fill('Packing list');await page.getByRole('button',{name:'Add evidence',exact:true}).click();
  await expect(page.getByRole('link',{name:'Packing list',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Mark task complete',exact:true}).click();
  await expect(page.locator('dd').filter({hasText:/^done$/})).toBeVisible();
  const completed=await api(`/tasks/${taskId}`);assert.equal(completed.checklist.tasks[0].status,'done');
  await page.locator('summary').filter({hasText:/^Change status$/}).click();
  await page.getByLabel('Status',{exact:true}).selectOption('cancelled');await page.getByRole('button',{name:'Update status',exact:true}).click();
  await expect(page.locator('dd').filter({hasText:/^cancelled$/})).toBeVisible();
  await page.getByRole('button',{name:'Reopen task',exact:true}).click();
  await expect(page.locator('dd').filter({hasText:/^open$/})).toBeVisible();
  console.log('PASS standalone task, tags, bounded detail, checklist, evidence and completion/cancel/reopen');

  await page.getByText('Edit task',{exact:true}).click();
  await page.getByLabel('Task',{exact:true}).fill('Unsaved stale title');
  let current=(await api(`/tasks/${taskId}`)).task;
  await api(`/tasks/${taskId}`,'PATCH',{expectedRevision:current.revision,body:'Concurrent saved detail'});
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByText(/This record changed since you opened it/)).toBeVisible();
  await expect(page.getByLabel('Task',{exact:true})).toHaveValue('Unsaved stale title');
  await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
  await goto(taskPath);await page.getByText('Edit task',{exact:true}).click();
  await page.getByLabel('Task',{exact:true}).fill(title);
  await writeFile(path.join(directory,'mode'),'work-save-uncertain');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByText(/The save could not be confirmed/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
  await writeFile(path.join(directory,'mode'),'');await goto(taskPath);
  await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  console.log('PASS stale and uncertain edits retain values and prevent unsafe retry');
  await page.getByText('Edit task',{exact:true}).click();await page.getByText('Find more projects',{exact:true}).click();
  await page.getByLabel('Search by name',{exact:true}).fill('Pagination project');await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByRole('button',{name:'Next choices',exact:true})).toBeVisible();await page.getByRole('button',{name:'Next choices',exact:true}).click();
  await expect(page.getByLabel('Project',{exact:true}).locator('option').filter({hasText:'Pagination project 55'})).toHaveCount(1);
  await page.getByLabel('Project',{exact:true}).selectOption({label:'Pagination project 55'});
  const selectedProject=await page.getByLabel('Project',{exact:true}).inputValue();
  await page.getByLabel('Search by name',{exact:true}).fill('No matching projects here');await page.getByRole('button',{name:'Search',exact:true}).click();
  await expect(page.getByText('No matches.',{exact:true})).toBeVisible();await expect(page.getByLabel('Project',{exact:true})).toHaveValue(selectedProject);
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByRole('link',{name:'Pagination project 55',exact:true})).toBeVisible();
  current=(await api(`/tasks/${taskId}`)).task;await api(`/tasks/${taskId}`,'PATCH',{expectedRevision:current.revision,projectId:null});
  console.log('PASS paged project selector preserves a choice outside search results');

  const projectName=`Browser project ${Date.now()}`;
  await goto('/work/projects/new');await page.getByLabel('Name',{exact:true}).fill(projectName);await page.getByRole('button',{name:'Create project',exact:true}).click();
  await expect(page).toHaveURL(/\/work\/projects\/[0-9a-f-]+$/);const projectPath=new URL(page.url()).pathname;
  await expect(page.getByText('No tasks on this page.',{exact:true})).toBeVisible();
  await page.getByText('Edit project',{exact:true}).click();await page.getByLabel('Archived',{exact:true}).check();await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByText(/^archived ·/,{exact:true})).toBeVisible();
  await goto('/work/projects?state=archived');await expect(page.getByRole('link',{name:new RegExp(projectName)})).toBeVisible();
  await goto(projectPath);await page.getByText('Edit project',{exact:true}).click();await page.getByLabel('Archived',{exact:true}).uncheck();await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByText(/^active ·/,{exact:true})).toBeVisible();
  console.log('PASS projects create/archive/restore and bounded history');

  await goto('/work/series/new');const seriesTitle=`Recurring inspection ${Date.now()}`;
  await page.getByLabel('Recurring task',{exact:true}).fill(seriesTitle);await page.getByLabel('First period starts').fill('2020-01-01');
  await page.getByRole('button',{name:'Create recurring work',exact:true}).click();await expect(page).toHaveURL(/\/work\/series\/[0-9a-f-]+$/);
  const seriesId=page.url().split('/').pop();assert.equal((await api(`/series/${seriesId}`)).projectId,null);
  await expect(page.locator('.work-task').filter({hasText:seriesTitle})).toBeVisible();
  await page.getByText('Edit recurring work',{exact:true}).click();await page.getByLabel('Pause new occurrences').check();await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByText('Paused · monthly',{exact:true})).toBeVisible();
  await goto('/work/series?paused=true');await expect(page.getByRole('link',{name:new RegExp(seriesTitle)})).toBeVisible();
  console.log('PASS standalone recurring work materialises and can be paused');

  await goto(`/resources/equipment/new?equipmentId=${fixture.equipment[2].id}&date=2030-10-10`);
  await expect(page.getByLabel('Project',{exact:true})).toHaveValue('');
  await page.getByLabel('Task',{exact:true}).selectOption(taskId);
  await page.getByLabel('Title',{exact:true}).fill('Standalone task booking');
  await page.getByLabel('Starts',{exact:true}).fill('2030-10-10T09:00');await page.getByLabel('Ends',{exact:true}).fill('2030-10-10T10:00');
  await page.getByRole('button',{name:'Reserve',exact:true}).click();await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]+$/);
  const bookingId=page.url().split('/').pop(),route=`/equipment/${fixture.equipment[2].id}/reservations/${bookingId}`;
  assert.equal((await api(route)).projectId,null);
  current=(await api(`/tasks/${taskId}`)).task;
  await api(`/tasks/${taskId}`,'PATCH',{expectedRevision:current.revision,projectId:fixture.projectId});
  await page.getByLabel('Title',{exact:true}).fill('Stale booking edit');await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByText(/This changed since you opened it/)).toBeVisible();
  assert.equal((await api(route)).projectId,fixture.projectId);
  await goto(`/resources/equipment/${fixture.equipment[2].id}/reservations/${bookingId}`);
  await expect(page.getByLabel('Project',{exact:true})).toHaveValue(fixture.projectId);await expect(page.getByLabel('Task',{exact:true})).toHaveValue(taskId);
  await expect(page.getByRole('link',{name:title,exact:true})).toHaveAttribute('href',taskPath);
  await goto(`/commitments#task-${taskId}`);await expect(page).toHaveURL(new RegExp(taskPath));
  console.log('PASS standalone booking, linked Work record, cascade/stale booking and legacy redirect');
  await mkdir(path.join(directory, 'screenshots'), { recursive: true });
  for (const width of [390, 1440]) {
   await page.setViewportSize({ width, height: 900 });
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
   await page.screenshot({ path: path.join(directory, `screenshots/optional-booking-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []); console.log('PASS phone/desktop task details and no browser runtime errors');
 } catch(error){await page.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error('PAGE',page.url(),await page.locator('main').innerText().catch(()=>''));throw error;} finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
