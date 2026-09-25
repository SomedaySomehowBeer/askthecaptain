/** Local production web + workspace-fixture only. Exercises checklist writes and structural parent navigation. */
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
  const project=await api('/projects','POST',{name:'Navigation project'});
  const task=await api('/tasks','POST',{title:'Parent packing task',projectId:project.id,ownerId:fixture.userId});
  const child=await api('/tasks','POST',{parentId:task.id,expectedParentRevision:task.revision,title:'Check the labels'});
  const taskPath=`/work/tasks/${task.id}`, childPath=`/work/tasks/${child.id}`, projectPath=`/work/projects/${project.id}`;
  const up=page.getByRole('navigation',{name:'Section navigation'});
  await goto(taskPath);
  const box=page.getByRole('checkbox',{name:'Complete Check the labels',exact:true});
  await expect(box).not.toBeChecked();await box.click();await expect(box).toBeChecked();
  await expect(page).toHaveURL(origin+taskPath);assert.equal((await api(`/tasks/${child.id}`)).task.status,'done');
  await page.reload();await expect(box).toBeChecked();await box.click();await expect(box).not.toBeChecked();
  assert.equal((await api(`/tasks/${child.id}`)).task.status,'open');
  await page.getByRole('link',{name:/Check the labels/}).click();await expect(page).toHaveURL(origin+childPath);
  await up.getByRole('link',{name:'Back to Parent packing task',exact:true}).click();await expect(page).toHaveURL(origin+taskPath);
  await up.getByRole('link',{name:'Back to Navigation project',exact:true}).click();await expect(page).toHaveURL(origin+projectPath);
  await up.getByRole('link',{name:'Back to Projects',exact:true}).click();await expect(page).toHaveURL(origin+'/work/projects');
  await goto(taskPath+'/tags');await up.getByRole('link',{name:'Back to Parent packing task',exact:true}).click();await expect(page).toHaveURL(origin+taskPath);
  await goto(`/work/new?projectId=${project.id}`);await up.getByRole('link',{name:'Back to Navigation project',exact:true}).click();await expect(page).toHaveURL(origin+projectPath);
  const series=await api('/series','POST',{title:'Recurring parent test',projectId:project.id,recurrence:'monthly',anchor:'2020-01-01',dueOffsetDays:0});
  const occurrence=(await api(`/tasks?seriesId=${series.id}`)).tasks[0];
  await goto(`/work/tasks/${occurrence.id}`);await up.getByRole('link',{name:'Back to Recurring parent test'}).click();await expect(page).toHaveURL(origin+`/work/series/${series.id}`);
  await up.getByRole('link',{name:'Back to Navigation project'}).click();await expect(page).toHaveURL(origin+projectPath);
  console.log('PASS persistent completion/reopen and checklist/task/project/tags/create hierarchy');
  await goto(taskPath);
  let current=(await api(`/tasks/${child.id}`)).task;
  await api(`/tasks/${child.id}`,'PATCH',{expectedRevision:current.revision,body:'Concurrent edit'});
  await box.click();await expect(page.locator('main').getByRole('alert')).toContainText('This record changed');await expect(box).toBeDisabled();await expect(box).not.toBeChecked();
  await page.getByRole('link',{name:'Reload checklist'}).click();await expect(box).toBeEnabled();
  await writeFile(path.join(directory,'mode'),'work-save-uncertain');
  await box.click();await expect(page.locator('main').getByRole('alert')).toContainText('The save could not be confirmed');await expect(box).toBeDisabled();await expect(box).not.toBeChecked();
  await writeFile(path.join(directory,'mode'),'');await page.getByRole('link',{name:'Reload checklist'}).click();await expect(box).toBeChecked();
  console.log('PASS stale and uncertain checkbox saves require reconciliation');
  for(const width of [360,390,1440]){
   await page.setViewportSize({width,height:874});await goto(taskPath);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await expect(up.getByRole('link',{name:'Back to Navigation project'})).toBeVisible();
   const target=await page.locator('.work-checklist-item__toggle').boundingBox();assert(target.width>=44&&target.height>=44);
   await page.screenshot({path:path.join(directory,`checklist-${width}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);console.log('PASS phone/desktop sizing and no browser exceptions');
 } catch(error){await page.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error('PAGE',page.url(),await page.locator('main').innerText().catch(()=>''));throw error;} finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
