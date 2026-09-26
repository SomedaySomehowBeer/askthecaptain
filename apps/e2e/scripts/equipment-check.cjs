/** Local-only production web + real Postgres proof. Never point this script at hosted data. */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw Error('WORKSPACE_PROBE_DIR is required');
const origin = 'http://127.0.0.1:3034';
(async () => {
 const fixture = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(fixture.fixture, 'captain-workspace-local');
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
 if (process.env.CHROME_CDP_URL) await context.route(`${origin}/**`, async route => {
  const response = await route.fetch({ maxRedirects: 0 }), location = response.headers().location;
  if (location && response.status() >= 300 && response.status() < 400 && route.request().isNavigationRequest()) {
   const destination = new URL(location, route.request().url()).href;
   await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination).replace(/</g, '\\u003c')})</script>` });
  } else await route.fulfill({ response });
 });
 const page = await context.newPage(), errors=[]; page.setDefaultTimeout(15000); page.on('pageerror',e=>errors.push(e.message));
 const mode = value => writeFile(path.join(directory,'mode'),value);
 // Pace full navigations so fixture setup plus Next prefetches respect the real API limiter.
 const goto = async route => { await new Promise(resolve=>setTimeout(resolve,5000)); return page.goto(origin+route); };
 const equip = fixture.equipment;
 const api = async (route, method='GET', body) => {
  const response=await fetch('http://127.0.0.1:8084'+fixture.base+route,{method,headers:{authorization:`Bearer ${fixture.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  assert.ok(response.ok,`${route}: ${response.status} ${await response.clone().text()}`);return response.json();
 };
 const bookingPath = (equipmentId,id) => `/resources/equipment/${equipmentId}/reservations/${id}`;
 const newForm = async (equipmentId,title,start,end) => {
  await goto(`/resources/equipment/new?equipmentId=${equipmentId}&date=2030-10-10`);
  await page.getByLabel('Title',{exact:true}).fill(title);
  await page.getByLabel('Starts',{exact:true}).fill(start);
  await page.getByLabel('Ends',{exact:true}).fill(end);
 };
 const saveNew = async () => {await page.getByRole('button',{name:'Reserve',exact:true}).click();await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]+$/);};
 const proof = async name => {assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} overflow`);await page.screenshot({path:path.join(directory,'screenshots',name+'.png'),fullPage:true});};
 await mkdir(path.join(directory,'screenshots'),{recursive:true});
 try {
  await mode('');
  for(const route of ['/resources/equipment','/resources/equipment/manage',`/resources/equipment/new?equipmentId=${equip[0].id}`,bookingPath(equip[0].id,fixture.bookingId)]){
   assert.equal((await fetch(origin+route,{redirect:'manual'})).status,307);
  }
  await context.addCookies([{name:'captain_session',value:fixture.token,url:origin}]);
  await goto('/resources/views');await page.getByRole('link',{name:/Equipment schedule/}).click();await expect(page.getByRole('heading',{name:'Equipment',exact:true})).toBeVisible();
  await goto('/resources/equipment?date=2030-10-01');
  const view=page.locator('.equipment-viewport');
  await expect(page.locator('.equipment-lane')).toHaveCount(8);
  await expect(page.getByRole('button',{name:'Next equipment',exact:true})).toBeEnabled();
  assert.ok(await page.locator('.equipment-booking').filter({hasText:'Multi-day lager'}).evaluate(el=>el.getBoundingClientRect().height)>250,'multi-day continuous interval');
  await view.evaluate(el=>{el.scrollTop=200});
  const before=await view.evaluate(el=>({top:el.scrollTop,height:el.clientHeight}));
  await page.getByRole('button',{name:'Hours',exact:true}).click();await expect(view).toHaveAttribute('data-scale','hours');
  const after=await view.evaluate(el=>el.scrollTop);
  assert.ok(Math.abs(after-((before.top+before.height/2-52)/84*576-before.height/2+52))<2,'focal zoom');
  await page.getByRole('button',{name:'Days',exact:true}).click();
  await page.getByRole('button',{name:'Next equipment',exact:true}).click();await expect.poll(()=>view.evaluate(el=>el.scrollLeft)).toBeGreaterThan(100);
  await proof('equipment-phone');
  await page.getByRole('link',{name:'More equipment',exact:true}).click();await expect(page.locator('.equipment-head')).toContainText('I Pilot kit');
  await goto('/resources/equipment?date=2030-10-01&scale=weeks');await expect(view).toHaveAttribute('data-scale','weeks');
  await page.getByRole('button',{name:'Days',exact:true}).click();await expect(view).toHaveAttribute('data-scale','days');
  await page.getByRole('button',{name:'Weeks',exact:true}).click();await expect(view).toHaveAttribute('data-scale','weeks');
  // Touch events exercise the chart handler; native-device gesture acceptance remains a separate check.
  await view.dispatchEvent('pointerdown',{pointerId:1,pointerType:'touch',clientX:120,clientY:400});
  await view.dispatchEvent('pointerdown',{pointerId:2,pointerType:'touch',clientX:220,clientY:400});
  // Synthetic pointers are not active capture targets; stub capture for this handler-only check.
  await view.evaluate(el=>{el.setPointerCapture=()=>{}});
  await view.dispatchEvent('pointermove',{pointerId:2,pointerType:'touch',clientX:260,clientY:400});
  await expect(view).toHaveAttribute('data-scale','days');
  await view.dispatchEvent('pointerup',{pointerId:1,pointerType:'touch'});await view.dispatchEvent('pointerup',{pointerId:2,pointerType:'touch'});
  console.log('PASS continuous timeline, focal zoom, equipment scroll/paging and touch-handler zoom');

  await goto('/resources/equipment?date=2030-10-01');
  await page.getByText('Go to a date',{exact:true}).click();await expect(page.getByLabel('Date',{exact:true})).toBeVisible();await page.getByText('Go to a date',{exact:true}).click();
  await proof('equipment-phone-overview');
  await goto('/resources/equipment/manage');await page.getByLabel('Add equipment',{exact:true}).fill('Browser equipment');await page.getByRole('button',{name:'Add equipment',exact:true}).click();
  await expect(page.getByText('Added “Browser equipment”.',{exact:true})).toBeVisible();
  const row=page.locator('.equipment-row').filter({hasText:'Browser equipment'});await row.getByText('Rename',{exact:true}).first().click();await row.getByLabel('New name',{exact:true}).fill('Browser equipment renamed');await row.getByRole('button',{name:'Rename',exact:true}).click();await expect(row).toContainText('Browser equipment renamed');
  await row.getByRole('button',{name:'Archive Browser equipment renamed',exact:true}).click();await expect(page.locator('.equipment-row').filter({hasText:'Browser equipment renamed'})).toHaveCount(0);
  await page.getByRole('link',{name:'Archived',exact:true}).click();const archived=page.locator('.equipment-row').filter({hasText:'Browser equipment renamed'});await archived.getByRole('button',{name:'Restore Browser equipment renamed',exact:true}).click();await expect(archived).toHaveCount(0);
  const standalone = await api('/tasks', 'POST', { title: 'Standalone equipment task' });
  assert.equal(standalone.projectId, null);
  await newForm(equip[2].id,'Browser booking','2030-10-10T09:00','2030-10-10T11:00');
  await page.getByLabel('Setup before (minutes)',{exact:true}).fill('15');await page.getByLabel('Cleanup after (minutes)',{exact:true}).fill('30');
  await expect(page.getByLabel('Project',{exact:true})).toHaveValue('');await page.getByLabel('Task',{exact:true}).selectOption(standalone.id);
  await saveNew();const createdUrl=page.url(),createdId=createdUrl.split('/').pop();
  await expect(page.getByRole('heading',{name:'Browser booking',exact:true})).toBeVisible();await expect(page.getByText('Revision 1',{exact:true})).toBeVisible();
  await expect(page.locator('.equipment-plus')).toHaveCount(0);
  await page.getByLabel('Title',{exact:true}).fill('Browser booking revised');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByText('Revision 2',{exact:true})).toBeVisible();await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Browser booking revised');
  await proof('reservation-phone');
  const stored=await api(`/equipment/${equip[2].id}/reservations/${createdId}`);
  assert.equal(stored.setupMinutes,15);assert.equal(stored.taskId,standalone.id);assert.equal(stored.projectId,null);
  const payload=({title,kind,startsAt,endsAt,setupMinutes,cleanupMinutes,projectId,taskId,ownerId})=>({title,kind,startsAt,endsAt,setupMinutes,cleanupMinutes,projectId,taskId,ownerId});
  await api(`/equipment/${equip[2].id}/reservations/${createdId}`,'PATCH',{...payload(stored),title:'Changed elsewhere',expectedRevision:2});
  await page.getByLabel('Title',{exact:true}).fill('Stale browser edit');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByText(/This changed since you opened it/)).toBeVisible();await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
  await goto(createdUrl.slice(origin.length));await page.getByRole('button',{name:'Cancel this reservation',exact:true}).click();await page.getByRole('button',{name:'Cancel “Changed elsewhere”',exact:true}).click();await expect(page.getByText('Cancelled',{exact:true})).toBeVisible();
  console.log('PASS catalogue lifecycle, work-linked create/edit, stale-write refusal and cancellation');

  await newForm(equip[0].id,'Conflicting request','2030-10-02T09:00','2030-10-02T10:00');await page.getByRole('button',{name:'Reserve',exact:true}).click();await expect(page.getByText(/unavailable for part of this time/)).toBeVisible();await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Conflicting request');
  await mode('reservation-save-uncertain');await newForm(equip[3].id,'Uncertain saved booking','2030-10-10T09:00','2030-10-10T10:00');await page.getByRole('button',{name:'Reserve',exact:true}).click();await expect(page.getByRole('button',{name:'Reserve',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Check whether it was saved',exact:true})).toBeVisible();await mode('');await page.getByRole('button',{name:'Check whether it was saved',exact:true}).click();await expect(page.getByRole('heading',{name:'Uncertain saved booking',exact:true})).toBeVisible();
  await mode('reservation-save-failed');await newForm(equip[4].id,'Uncertain missing booking','2030-10-10T09:00','2030-10-10T10:00');await page.getByRole('button',{name:'Reserve',exact:true}).click();await expect(page.getByRole('button',{name:'Check whether it was saved',exact:true})).toBeVisible();await mode('');await page.getByRole('button',{name:'Check whether it was saved',exact:true}).click();await page.getByRole('button',{name:'Send the same request again',exact:true}).click();await expect(page.getByRole('heading',{name:'Uncertain missing booking',exact:true})).toBeVisible();
  console.log('PASS conflict input retention and uncertain-create reconciliation/retry');

  await mode('reservations-partial');await goto('/resources/equipment?date=2030-10-01');await expect(page.locator('.equipment-reservations [data-coverage=partial]')).toHaveCount(8);await expect(page.getByText(/Gaps are not confirmed free/).first()).toBeVisible();
  await mode('reservations-failed');await goto('/resources/equipment?date=2030-10-01');await expect(page.locator('.equipment-reservations [data-coverage=failed]')).toHaveCount(8);await expect(page.getByText(/No confirmed reservations on these dates/)).toHaveCount(0);
  await mode('equipment-failed');await goto('/resources/equipment');await expect(page.getByRole('heading',{name:'Equipment could not be loaded.',exact:true})).toBeVisible();
  await mode('equipment-lookups-failed');await goto(createdUrl.slice(origin.length));await expect(page.getByText('Cancelled',{exact:true})).toBeVisible();
  await mode('equipment-zone-sydney');await newForm(equip[5].id,'DST proof','2026-10-04T02:30','2026-10-04T04:00');await expect(page.getByText(/This time does not exist in Australia\/Sydney/)).toBeVisible();await page.getByRole('button',{name:'Reserve',exact:true}).click();await expect(page.getByText(/That local time does not exist/)).toBeVisible();
  await page.getByLabel('Starts',{exact:true}).fill('2026-04-05T02:30');await page.getByLabel('Ends',{exact:true}).fill('2026-04-05T03:30');await page.getByLabel('Second (UTC+10:00)',{exact:true}).check();await saveNew();
  const dstId=page.url().split('/').pop();assert.equal((await api(`/equipment/${equip[5].id}/reservations/${dstId}`)).startsAt,'2026-04-04T16:30:00.000Z');
  await page.getByLabel('First (UTC+11:00)',{exact:true}).check();await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.getByText('Revision 2',{exact:true})).toBeVisible();assert.equal((await api(`/equipment/${equip[5].id}/reservations/${dstId}`)).startsAt,'2026-04-04T15:30:00.000Z');
  await mode('');await page.getByLabel('Title',{exact:true}).fill('Timezone changed');await page.getByRole('button',{name:'Save changes',exact:true}).click();await expect(page.locator('main').getByRole('alert')).toContainText(/timezone|time zone/i);
  console.log('PASS honest partial/failed states, DST gap/repeated-hour edit and timezone-change refusal');
  await page.setViewportSize({width:1440,height:1000});await goto('/resources/equipment?date=2030-10-01');await proof('equipment-desktop');
  await goto('/resources/equipment/manage');await proof('catalogue-desktop');
  assert.deepEqual(errors,[]);console.log('PASS phone/desktop layouts and no browser exceptions');
 } catch(error){await page.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
 finally {await mode('');await context.unrouteAll({behavior: 'wait'});await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
