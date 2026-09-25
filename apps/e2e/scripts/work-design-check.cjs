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
  const org=await api('');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:org.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const day=n=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const project=await api('/projects','POST',{name:'Summer lager launch'});
  const task=await api('/tasks','POST',{title:'Confirm packaging slot',body:'Agree a packaging time for the release. Review equipment availability before confirming a booking.',projectId:project.id,ownerId:fixture.userId,due:today});
  await api(`/tasks/${task.id}/tags/${fixture.productionId}`,'PUT');
  for(const [title,status] of [['Check the existing reservation','done'],['Agree a new time with the team','open'],['Confirm the equipment booking','open']]) {
   const parent=(await api(`/tasks/${task.id}`)).task;
   await api('/tasks','POST',{parentId:task.id,expectedParentRevision:parent.revision,title,status});
  }
  const taskPath=`/work/tasks/${task.id}`;
  await goto(taskPath);
  await expect(page.getByRole('heading',{level:1,name:task.title,exact:true})).toHaveCount(1);
  await expect(page.getByLabel('Source link',{exact:true})).toBeHidden();
  await expect(page.getByLabel('Checklist item',{exact:true})).toBeHidden();
  await expect(page.getByLabel('Status',{exact:true})).toBeHidden();
  const complete=page.getByRole('button',{name:'Mark task complete',exact:true});
  await expect(complete).toBeVisible();
  for(const width of [360,390,430,1440]) {
   await page.setViewportSize({width,height:874});await goto(taskPath);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:path.join(directory,`task-design-${width}.png`),fullPage:true});
  }
  const step=page.getByRole('checkbox',{name:'Complete Agree a new time with the team',exact:true});
  await step.focus();await step.press('Space');await expect(step).toBeChecked();
  await expect(page.getByRole('status',{name:'Work updates'})).toContainText('Agree a new time with the team completed.');
  await expect(page.getByRole('status',{name:'Work updates'})).toBeFocused();
  await complete.click();await expect(page.getByRole('button',{name:'Reopen task',exact:true})).toBeVisible();
  assert((await api(`/tasks/${task.id}`)).checklist.tasks.every(t=>t.status==='done'));
  await page.getByRole('button',{name:'Reopen task',exact:true}).click();await expect(complete).toBeVisible();
  await page.locator('summary').filter({hasText:/^Change status$/}).click();await page.getByLabel('Status',{exact:true}).selectOption('in_progress');await page.getByRole('button',{name:'Update status',exact:true}).click();
  await expect(page.locator('dd').filter({hasText:/^in progress$/})).toBeVisible();
  console.log('PASS compact task, one accessible heading, primary completion/reopen and secondary status');
  for(const [title,due] of [['Approve can artwork',day(-1)],['Call the stockist about samples',today],['Prepare distributor samples',day(1)],['Plan October content',day(5)]]) {
   const row=await api('/tasks','POST',{title,projectId:project.id,ownerId:fixture.userId,due});await api(`/tasks/${row.id}/tags/${fixture.productionId}`,'PUT');
  }
  const workPath=`/work?owner=all&status=all&projectId=${project.id}`;
  await goto(workPath);
  for(const name of ['Overdue','Due today','Tomorrow','Next 7 days'])await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
  const artwork=page.getByRole('checkbox',{name:'Complete Approve can artwork',exact:true});
  await artwork.click();await expect(artwork).toBeChecked();await expect(page).toHaveURL(origin+workPath);
  await expect(page.getByRole('heading',{name:'Completed',exact:true})).toBeVisible();
  await expect(page.locator('.work-due-group').filter({has:page.getByRole('heading',{name:'Completed',exact:true})}).locator('time').first()).toHaveAttribute('title',`Due ${day(-1)}`);
  await artwork.click();await expect(artwork).not.toBeChecked();
  await goto(`/work?owner=all&projectId=${project.id}`);
  await artwork.focus();await artwork.press('Space');await expect(artwork).toHaveCount(0);
  await expect(page.getByRole('status',{name:'Work updates'})).toContainText('Approve can artwork completed.');
  await expect(page.getByRole('status',{name:'Work updates'})).toBeFocused();
  for(const width of [360,390,430,1440]) {
   await page.setViewportSize({width,height:874});await goto(workPath);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:path.join(directory,`work-design-${width}.png`),fullPage:true});
  }
  await page.getByRole('navigation',{name:'Work type'}).getByRole('link',{name:'Projects',exact:true}).click();await expect(page).toHaveURL(origin+'/work/projects');
  await page.getByRole('navigation',{name:'Work type'}).getByRole('link',{name:'Tasks',exact:true}).click();await expect(page).toHaveURL(origin+'/work');
  console.log('PASS grouped work, in-place list completion/reopen, filtered removal and Tasks/Projects switch');
  const series=await api('/series','POST',{title:'Evidence-required inspection',projectId:project.id,ownerId:fixture.userId,recurrence:'monthly',anchor:today,evidenceRequired:true,dueOffsetDays:0});
  const occurrence=(await api(`/tasks?seriesId=${series.id}`)).tasks[0];
  await goto(workPath);const required=page.getByRole('checkbox',{name:`Complete ${occurrence.title}`,exact:true});await required.click();
  await expect(page.locator('main').getByRole('alert')).toContainText('evidence');await expect(required).not.toBeChecked();
  assert.equal((await api(`/tasks/${occurrence.id}`)).task.status,'open');
  await goto(`/work/tasks/${occurrence.id}`);await page.getByRole('button',{name:'Mark task complete',exact:true}).click();await expect(page.locator('main').getByRole('alert')).toContainText('evidence');
  assert.equal((await api(`/tasks/${occurrence.id}`)).task.status,'open');
  await page.locator('summary').filter({hasText:/^Add evidence$/}).click();await page.getByLabel('Source link',{exact:true}).fill('https://example.com/inspection');await page.getByLabel('Label',{exact:true}).fill('Inspection source');await page.getByRole('button',{name:'Add evidence',exact:true}).click();
  await expect(page.getByRole('link',{name:'Inspection source',exact:true})).toBeVisible();await page.getByRole('button',{name:'Mark task complete',exact:true}).click();await expect(page.getByRole('button',{name:'Reopen task',exact:true})).toBeVisible();
  assert.deepEqual(errors,[]);console.log('PASS evidence-required tasks refuse both completion controls until evidence exists');
 } catch(error){await page.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});console.error('PAGE',page.url(),await page.locator('main').innerText().catch(()=>''));throw error;} finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
