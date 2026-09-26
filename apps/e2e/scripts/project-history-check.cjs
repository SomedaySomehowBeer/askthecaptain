/** Project task history against a disposable real API/Postgres fixture and production web. */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile } = require('node:fs/promises');
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
  await writeFile(path.join(directory,'mode'),'');await context.addCookies([{name:'captain_session',value:fixture.token,url:origin}]);
  const project=await api('/projects','POST',{name:'Project history proof'}),href=`/work/projects/${project.id}?view=tasks`;
  const open=await api('/tasks','POST',{title:'Prepare current release',projectId:project.id,status:'open',ownerId:fixture.userId});
  for(const [status,title] of [['in_progress','Packaging underway'],['cancelled','Cancelled release'],['suggested','Suggested follow-up']])await api('/tasks','POST',{title,projectId:project.id,status});
  for(let n=0;n<7;n++)await api('/tasks','POST',{title:`Older completed work ${n+1}`,projectId:project.id,status:'done',due:'2020-01-01'});
  await goto(href);const filters=page.getByRole('navigation',{name:'Task status'}),updates=page.getByRole('status',{name:'Work updates'});
  await expect(filters.getByRole('link',{name:'Open',exact:true})).toHaveAttribute('aria-current','page');
  await expect(page.locator('.work-task')).toHaveCount(1);await expect(page.locator('.work-task')).toContainText(open.title);
  await expect(page.getByText(/Older completed work/)).toHaveCount(0);
  const checkbox=page.getByRole('checkbox',{name:`Complete ${open.title}`,exact:true});await checkbox.focus();await checkbox.press('Space');await expect(checkbox).toHaveCount(0);
  await expect(updates).toBeFocused();await expect(updates).toContainText('completed.');await expect(page.getByText('No open tasks on this page.',{exact:true})).toBeVisible();
  await filters.getByRole('link',{name:'Completed',exact:true}).click();await expect(page.locator('.work-task')).toHaveCount(8);
  await checkbox.focus();await checkbox.press('Space');await expect(checkbox).toHaveCount(0);await expect(updates).toBeFocused();await expect(updates).toContainText('reopened.');
  await filters.getByRole('link',{name:'In progress',exact:true}).click();await expect(page.locator('.work-task')).toHaveCount(1);await expect(page.locator('.work-task')).toContainText('Packaging underway');
  await filters.getByRole('link',{name:'Suggested',exact:true}).click();await expect(page.locator('.work-task')).toHaveCount(1);await expect(page.locator('.work-task')).toContainText('Suggested follow-up');
  await filters.getByRole('link',{name:'Cancelled',exact:true}).click();await expect(page.getByRole('checkbox',{name:'Complete Cancelled release',exact:true})).toBeDisabled();
  await filters.getByRole('link',{name:'All except cancelled',exact:true}).click();await expect(page.locator('.work-task')).toHaveCount(10);await expect(page.locator('.work-list')).toContainText('Suggested follow-up');
  await goto(href+'&status=done&offset=50');await expect(page.getByText('No completed tasks on this page.',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Previous tasks',exact:true})).toHaveAttribute('href',/status=done&offset=0$/);
  await filters.getByRole('link',{name:'Open',exact:true}).click();await expect(page).not.toHaveURL(/offset=/);await expect(page.locator('.work-task')).toHaveCount(1);
  await goto(`/work/projects/${project.id}?status=cancelled`);await expect(filters.getByRole('link',{name:'Cancelled',exact:true})).toHaveAttribute('aria-current','page');
  await goto(`/work/projects/${project.id}`);await expect(page.getByRole('region',{name:'Across the project'}).getByRole('link',{name:'Tasks',exact:false}).first()).toHaveAttribute('href',/view=tasks&status=all$/);
  console.log('PASS separate task statuses, completed-history exclusion, persistent keyboard feedback, paging reset and old cancelled links');
  for(const width of [360,390,430,1440]){await page.setViewportSize({width,height:874});await goto(href);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(directory,`project-history-${width}.png`),fullPage:true});}
  await goto(`/work/projects/${project.id}?view=schedule`);await expect(page.getByRole('button',{name:'Show bookings',exact:true})).toHaveClass(/button--secondary/);
  assert.deepEqual(errors,[]);console.log('PASS phone/desktop task filters, schedule action and no browser exceptions');
 } catch(error){await page.screenshot({path:path.join(directory,'project-history-failure.png'),fullPage:true}).catch(()=>{});throw error;}
 finally {await context.unrouteAll({behavior: 'wait'});await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
