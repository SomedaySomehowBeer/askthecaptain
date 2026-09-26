/** Project overview/schedule against a disposable real API/Postgres fixture and production web. */
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
  await writeFile(path.join(directory,'mode'),'');
  await context.addCookies([{name:'captain_session',value:fixture.token,url:origin}]);
  const org=await api('');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:org.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const day=n=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const project=await api('/projects','POST',{name:'Summer lager launch',ownerId:fixture.userId});
  const projectPath=`/work/projects/${project.id}`,tasks=[];
  const marketing=await api('/tags','POST',{name:'Marketing'}),admin=await api('/tags','POST',{name:'Admin'});
  for(const [title,tagId,n] of [['Confirm packaging slot',fixture.productionId,0],['Approve can artwork',marketing.id,0],['Prepare distributor samples',fixture.salesId,2],['Check launch budget',admin.id,3]]) {
   const t=await api('/tasks','POST',{title,projectId:project.id,ownerId:fixture.userId,due:day(n)});
   await api(`/tasks/${t.id}/tags/${tagId}`,'PUT');tasks.push(t);
  }
  for(let n=0;n<7;n++)await api('/tasks','POST',{title:`Finished earlier ${n+1}`,projectId:project.id,status:'done',due:day(-10)});
  await api(`/tasks/${tasks[0].id}`,'PATCH',{expectedRevision:tasks[0].revision,status:'in_progress'});
  const baseTime=Date.parse(day(1)+'T01:00:00Z');
  const booking=await api(`/equipment/${fixture.equipment[0].id}/reservations`,'POST',{id:crypto.randomUUID(),title:'Tank preparation',startsAt:new Date(baseTime).toISOString(),endsAt:new Date(baseTime+7200000).toISOString(),projectId:project.id,taskId:tasks[0].id,ownerId:fixture.userId,setupMinutes:30,cleanupMinutes:15});
  const bookingPath=`/resources/equipment/${booking.equipmentId}/reservations/${booking.id}`;
  await api(`/equipment/${fixture.equipment[1].id}/reservations`,'POST',{id:crypto.randomUUID(),title:'Other project only',startsAt:new Date(baseTime).toISOString(),endsAt:new Date(baseTime+7200000).toISOString(),projectId:fixture.projectId});
  await goto(projectPath);
  await expect(page.getByRole('navigation',{name:'Project views'}).getByRole('link',{name:'Overview',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('.project-context')).toContainText('Olive Owner owns this');
  await expect(page.locator('.project-stream')).not.toContainText('Finished earlier');
  await expect(page.locator('.project-stream')).toContainText('in progress');
  await expect(page.getByRole('heading',{level:1,name:project.name,exact:true})).toHaveCount(1);
  for(const tag of ['Production','Marketing','Sales','Admin'])await expect(page.locator('.project-stream strong').filter({hasText:tag})).toBeVisible();
  await expect(page.locator('.project-bookings')).toContainText('Tank preparation');
  await expect(page.getByText('Other project only',{exact:false})).toHaveCount(0);
  for(const view of ['overview','tasks','schedule'])for(const width of [360,390,430,1440]){
   await page.setViewportSize({width,height:874});await goto(projectPath+(view==='overview'?'':`?view=${view}`));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:path.join(directory,`project-${view}-${width}.png`),fullPage:true});
  }
  console.log('PASS populated overview, cross-tag work, project-only bookings and all three views at four widths');
  await goto(projectPath+'?view=tasks&status=all');
  const checkbox=page.getByRole('checkbox',{name:'Complete Confirm packaging slot',exact:true});
  await checkbox.focus();await checkbox.press('Space');await expect(checkbox).toBeChecked();
  await expect(page.getByRole('status',{name:'Work updates'})).toBeFocused();
  await expect(page).toHaveURL(origin+projectPath+'?view=tasks&status=all');
  assert.equal((await api(`/tasks/${tasks[0].id}`)).task.status,'done');
  await checkbox.click();await expect(checkbox).not.toBeChecked();
  await page.getByRole('link',{name:/^Confirm packaging slot/}).click();await expect(page).toHaveURL(origin+`/work/tasks/${tasks[0].id}`);
  await page.getByRole('link',{name:'Back to Summer lager launch',exact:true}).click();await expect(page).toHaveURL(origin+projectPath);
  await page.getByRole('link',{name:/A Fermenter · Tank preparation/}).click();await expect(page).toHaveURL(origin+bookingPath);
  await page.getByRole('link',{name:'Summer lager launch',exact:true}).click();await expect(page).toHaveURL(origin+projectPath);
  await page.getByRole('navigation',{name:'Project views'}).getByRole('link',{name:'Schedule',exact:true}).click();
  await page.getByRole('link',{name:/View shared equipment schedule/}).click();await expect(page).toHaveURL(/\/resources\/equipment\?date=/);
  console.log('PASS project tasks complete/reopen, keyboard confirmation and task/reservation/shared-schedule links');
  // More than a preview, then more than a schedule page. Use one equipment lane with nonoverlapping slots.
  // Fixture seeding and the first two groups nearly fill the real write-rate window.
  // Wait before the bulk booking setup, so neither it nor later fault checks hit that limit.
  await new Promise(resolve=>setTimeout(resolve,60000));
  for(let n=0;n<51;n++)await api(`/equipment/${fixture.equipment[2].id}/reservations`,'POST',{id:crypto.randomUUID(),title:`Schedule page booking ${n+1}`,startsAt:new Date(baseTime+n*7200000).toISOString(),endsAt:new Date(baseTime+n*7200000+3600000).toISOString(),projectId:project.id});
  for(let n=0;n<3;n++)await api('/tasks','POST',{title:`More launch work ${n+1}`,projectId:project.id});
  await goto(projectPath);await expect(page.getByText(/Showing the first six open or in-progress tasks/)).toBeVisible();await expect(page.getByText(/Showing the first three bookings/)).toBeVisible();
  await page.getByRole('link',{name:'View all bookings in this window',exact:true}).click();
  await expect(page.locator('.project-bookings > li')).toHaveCount(50);
  await page.getByRole('link',{name:'Next bookings',exact:true}).click();await expect(page.locator('.project-bookings > li')).toHaveCount(2);
  await page.getByRole('link',{name:'Previous bookings',exact:true}).click();await expect(page.locator('.project-bookings > li')).toHaveCount(50);
  await page.getByLabel('Starting date',{exact:true}).fill(day(20));await page.getByLabel('Window',{exact:true}).selectOption('7');await page.getByRole('button',{name:'Show bookings',exact:true}).click();
  await expect(page.getByText('No confirmed bookings overlap this window.',{exact:true})).toBeVisible();await expect(page).not.toHaveURL(/offset=/);
  await goto(projectPath+'?view=schedule&date=invalid');await expect(page.getByText('Schedule could not be read',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Open today’s project schedule',exact:true}).click();await expect(page.locator('.project-bookings > li')).toHaveCount(50);
  console.log('PASS bounded previews, booking pagination, date-window changes, empty and invalid schedule states');
  await writeFile(path.join(directory,'mode'),'project-bookings-failed');await goto(projectPath);
  await expect(page.getByText('Bookings could not be read',{exact:true})).toBeVisible();await expect(page.getByText('No confirmed bookings overlap this window.',{exact:true})).toHaveCount(0);await expect(page.locator('.project-stream > li')).toHaveCount(6);
  await writeFile(path.join(directory,'mode'),'failed');await goto(projectPath);
  await expect(page.getByText('Tasks could not be read',{exact:true})).toBeVisible();await expect(page.locator('.project-bookings > li')).toHaveCount(3);
  await writeFile(path.join(directory,'mode'),'');
  const empty=await api('/projects','POST',{name:'Empty project'});await goto(`/work/projects/${empty.id}`);
  await expect(page.getByText('No open or in-progress tasks in this project.',{exact:true})).toBeVisible();await expect(page.getByText('No confirmed bookings overlap this window.',{exact:true})).toBeVisible();
  await goto(projectPath);await page.getByText('Edit project',{exact:true}).click();await page.getByLabel('Archived',{exact:true}).check();await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.locator('.project-context')).toContainText('archived');await expect(page.getByRole('link',{name:'New task in this project',exact:true})).toHaveCount(0);await expect(page.locator('.project-bookings > li')).toHaveCount(3);
  await expect(page.getByRole('link',{name:'Back to Projects',exact:true})).toHaveAttribute('href','/work/projects?state=archived');
  assert.deepEqual(errors,[]);console.log('PASS independent read failures, empty project and archived history without fake availability');
 } catch(error){await page.screenshot({path:path.join(directory,'project-failure.png'),fullPage:true}).catch(()=>{});console.error('PAGE',page.url(),await page.locator('main').innerText().catch(()=>''));throw error;} finally {await writeFile(path.join(directory,'mode'),'');await context.unrouteAll({behavior: 'wait'});await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
