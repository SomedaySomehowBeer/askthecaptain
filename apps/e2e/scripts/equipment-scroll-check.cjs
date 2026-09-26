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
  await mode('');await context.addCookies([{name:'captain_session',value:fixture.token,url:origin}]);
  for(const [title,day] of [['Past month booking','2030-09-02'],['Six months ahead booking','2031-04-01']]){
   const existing=await api(`/equipment/${equip[0].id}/reservations?from=${day}T00:00:00.000Z&to=${day}T23:59:59.000Z`);
   if(!existing.reservations.some(r=>r.title===title))await api(`/equipment/${equip[0].id}/reservations`,'POST',{id:require('node:crypto').randomUUID(),title,kind:'booking',startsAt:day+'T01:00:00.000Z',endsAt:day+'T09:00:00.000Z',setupMinutes:0,cleanupMinutes:0});
  }
  const initialReadCount=(await (await fetch('http://127.0.0.1:8084/__fixture/stats')).json()).reservationReads.length;
  await goto('/resources/equipment?date=2030-10-01');
  const view=page.locator('.equipment-viewport'),lane=page.locator('.equipment-lane').first();
  await expect(view).toHaveAttribute('data-scale','days');
  await expect.poll(()=>view.evaluate(el=>el.scrollTop)).toBeGreaterThan(2400);
  assert.ok(await view.evaluate(el=>el.scrollHeight>200*84),'at least seven-month canvas');
  await expect(page.locator('.equipment-date-nav')).toContainText('1 Oct 2030');
  let stats=await (await fetch('http://127.0.0.1:8084/__fixture/stats')).json();
  assert.ok(new Set(stats.reservationReads.slice(initialReadCount).map(r=>r.from)).size<=2,'initial read is lazy');
  await expect(lane.locator('.equipment-booking').filter({hasText:'Multi-day lager'})).toHaveCount(1);
  await mode('reservations-delayed');
  await view.evaluate(el=>{el.scrollTop=el.scrollHeight-el.clientHeight});
  await expect(page.locator('.equipment-date-nav')).toContainText('2031');
  await expect(lane.locator('[data-coverage=loading]')).toHaveCount(1);
  await expect(page.getByRole('region',{name:'A Fermenter reservations'})).toContainText('Availability is unknown');
  await expect(lane.locator('.equipment-booking').filter({hasText:'Six months ahead booking'})).toHaveCount(1,{timeout:20000});
  const endTop=await view.evaluate(el=>el.scrollTop);assert.ok(endTop>200*84,'range does not re-anchor after a lazy read');await mode('');
  await expect(page.getByRole('region',{name:'A Fermenter reservations'})).toContainText('Six months ahead booking');
  assert.equal(await view.evaluate(el=>el.scrollTop),endTop,'loading does not reset scroll');
  const afterFuture=(await (await fetch('http://127.0.0.1:8084/__fixture/stats')).json()).reservationReads.slice(initialReadCount);
  assert.equal(afterFuture.filter(r=>r.from==='2030-09-30T16:00:00.000Z').length,8,'lazy reads do not repeat the anchor read');
  await proof('calendar-six-months-ahead');
  await view.evaluate(el=>{el.scrollTop=0});
  await expect(page.locator('.equipment-date-nav')).toContainText('1 Sept 2030');
  await expect(lane.locator('.equipment-booking').filter({hasText:'Past month booking'})).toHaveCount(1);
  await expect(page.getByRole('link',{name:/Reserve equipment:/})).toHaveAttribute('href',/date=2030-09-01/);
  await proof('calendar-one-month-back');
  console.log('PASS actual scrolling one calendar month back and six months ahead, lazy loading and stable scroll');

  // An unread middle chunk fails honestly, does not loop, and has a user-controlled retry.
  await mode('reservations-failed');
  await view.evaluate(el=>{el.scrollTop=98*84});
  await expect(lane.locator('[data-coverage=failed]')).toHaveCount(1);
  await expect(page.getByRole('region',{name:'A Fermenter reservations'})).toContainText('Availability is unknown');
  const failedCount=(await (await fetch('http://127.0.0.1:8084/__fixture/stats')).json()).reservationReads.length;
  await page.waitForTimeout(1500);
  assert.equal((await (await fetch('http://127.0.0.1:8084/__fixture/stats')).json()).reservationReads.length,failedCount,'no automatic failure loop');
  await mode('');await lane.getByRole('button',{name:/Retry A Fermenter/}).click();
  await expect(lane.locator('[data-coverage=failed]')).toHaveCount(0);
  await expect(page.getByRole('region',{name:'A Fermenter reservations'})).toHaveAttribute('data-coverage','complete');
  const before=await view.evaluate(el=>({top:el.scrollTop,height:el.clientHeight}));
  await page.getByRole('button',{name:'Hours',exact:true}).click();
  await expect(view).toHaveAttribute('data-scale','hours');
  const after=await view.evaluate(el=>el.scrollTop);
  assert.ok(Math.abs(after-((before.top+before.height/2-52)/84*576-before.height/2+52))<2,'hour zoom preserves focal date');
  await expect.poll(()=>page.locator('.equipment-axis>span').count(),{message:'hourly ticks virtualised'}).toBeLessThan(120);
  await page.getByRole('button',{name:'Next equipment',exact:true}).click();await expect.poll(()=>view.evaluate(el=>el.scrollLeft)).toBeGreaterThan(100);
  await page.getByRole('button',{name:'Weeks',exact:true}).click();await expect(view).toHaveAttribute('data-scale','weeks');
  await page.getByRole('button',{name:'Days',exact:true}).click();
  await page.getByText('Go to a date',{exact:true}).click();await page.getByLabel('Date',{exact:true}).fill('2030-10-01');await page.getByRole('button',{name:'Show date',exact:true}).click();
  await expect(page.locator('.equipment-date-nav')).toContainText('1 Oct 2030');
  await expect.poll(()=>view.evaluate(el=>el.scrollTop)).toBe(30*84);
  console.log('PASS failed-range retry, no request loop, focal zoom, bounded hourly DOM and date jump');

  await mode('reservations-partial');await goto('/resources/equipment?date=2030-10-01');
  await expect(page.getByRole('region',{name:'A Fermenter reservations'})).toHaveAttribute('data-coverage','partial');
  await expect(page.getByRole('region',{name:'A Fermenter reservations'})).toContainText('Gaps are not confirmed free');
  await mode('');
  for(const width of [360,390,430,1440]){await page.setViewportSize({width,height:900});await goto('/resources/equipment?date=2030-10-01');await proof('calendar-'+width);}
  stats=await (await fetch('http://127.0.0.1:8084/__fixture/stats')).json();
  for(const read of stats.reservationReads){const days=(Date.parse(read.to)-Date.parse(read.from))/86400000;assert.ok(days>0&&days<=29,'bounded civil-month reads');}
  assert.deepEqual(errors,[]);console.log('PASS partial coverage, responsive layouts, bounded requests and no browser exceptions');
 } catch(error){await page.screenshot({path:path.join(directory,'calendar-failure.png'),fullPage:true}).catch(()=>{});throw error;}
 finally {await mode('');await context.unrouteAll({behavior: 'wait'});await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
