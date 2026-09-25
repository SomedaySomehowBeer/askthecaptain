/** Local real-Postgres fixture only. Faults never touch a hosted session or customer's records. */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw Error('WORKSPACE_PROBE_DIR is required');
const origin = 'http://127.0.0.1:3034';
(async () => {
 const f = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(f.fixture, 'captain-workspace-local');
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 const context = await browser.newContext({ viewport: { width:390, height:844 } });
 if (process.env.CHROME_CDP_URL) await context.route(origin+'/**', async route => {
  const response = await route.fetch({maxRedirects:0}), location=response.headers().location;
  if(location && response.status()>=300 && response.status()<400 && route.request().isNavigationRequest()) {
   const destination=new URL(location,route.request().url()).href;
   await route.fulfill({status:200,contentType:'text/html',body:`<script>location.replace(${JSON.stringify(destination).replace(/</g,'\\u003c')})</script>`});
  } else await route.fulfill({response});
 });
 const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 const mode=value=>writeFile(path.join(directory,'mode'),value);
 const goto=async route=>{await new Promise(resolve=>setTimeout(resolve,2000));return page.goto(origin+route);};
 const signIn=()=>context.addCookies([{name:'captain_session',value:f.token,url:origin}]);
 const mutations=async()=> (await (await fetch('http://127.0.0.1:8084/__fixture/stats')).json()).mutationRequests;
 const assertCookie=async()=>assert.equal((await context.cookies(origin)).find(c=>c.name==='captain_session')?.value,f.token);
 const service=page.getByRole('heading',{name:'Captain can’t reach its service right now',exact:true});
 await mkdir(path.join(directory,'screenshots'),{recursive:true});
 try {
  await mode('');await signIn();await goto('/work');await expect(page.getByRole('heading',{name:'My work',exact:true})).toBeVisible();
  for(const fault of ['session-rate-limited','session-failed','session-network']) {
   await mode(fault);await goto('/work');await expect(service).toBeVisible();await expect(page).toHaveURL(/\/unavailable\?/);await assertCookie();
   await expect(page.getByRole('link',{name:'Try again',exact:true})).toHaveAttribute('href','/work');
   await page.getByRole('link',{name:'Try again',exact:true}).click();await expect(service).toBeVisible();await assertCookie();
   await goto('/sign-in?return_to=%2Fresources%2Fequipment');await expect(page.getByRole('heading',{name:'Captain can’t check your session right now.',exact:true})).toBeVisible();await expect(page).toHaveURL(/\/sign-in\?/);await expect(page.getByRole('link',{name:'Try again',exact:true})).toHaveAttribute('href','/resources/equipment');
   await mode('');await page.getByRole('link',{name:'Try again',exact:true}).click();await expect(page.getByRole('heading',{name:'Equipment',exact:true})).toBeVisible();await assertCookie();
  }
  console.log('PASS 429, 503 and actual dropped-connection recovery without losing the session');
  await mode('session-failed');
  for(const route of ['/commitments','/settings','/welcome','/settings/export']) {
   await goto(route);await expect(service).toBeVisible();await assertCookie();
  }
  await goto('/invitations/accept?token=fixture-invalid');await expect(page.locator('main')).toContainText(/not been signed out|service/i);await expect(page.getByRole('link',{name:'Try again',exact:true})).toBeVisible();
  await goto('/auth/passkey');await expect(page.locator('main')).toContainText(/service|unavailable|session/i);
  await goto('/unavailable?return_to=%2F%2Fevil.example');await expect(page.getByRole('link',{name:'Try again',exact:true})).toHaveAttribute('href','/work');
  await page.screenshot({path:path.join(directory,'screenshots','session-unavailable-phone.png')});
  await page.setViewportSize({width:1280,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(directory,'screenshots','session-unavailable-desktop.png')});await page.setViewportSize({width:390,height:844});
  console.log('PASS retained special-route access states, safe return target and phone/desktop retry page');
  await mode('');await goto('/work/new');await page.getByLabel('Task',{exact:true}).fill('Recovered session task');
  const before=await mutations();await mode('session-failed');await page.getByRole('button',{name:'Add task',exact:true}).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('nothing was sent');await expect(page.getByLabel('Task',{exact:true})).toHaveValue('Recovered session task');assert.equal(await mutations(),before);await assertCookie();
  await mode('');await page.getByRole('button',{name:'Add task',exact:true}).click();await expect(page).toHaveURL(/\/commitments#task-/);assert.equal(await mutations(),before+1);
  await goto('/resources/equipment/new?equipmentId='+f.equipment[2].id+'&date=2030-10-12');await page.getByLabel('Title',{exact:true}).fill('Session recovery reservation');
  const bookingBefore=await mutations();await mode('session-rate-limited');await page.getByRole('button',{name:'Reserve',exact:true}).click();await expect(page.locator('main').getByRole('alert')).toContainText('nothing was sent');assert.equal(await mutations(),bookingBefore);await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Session recovery reservation');
  await mode('reservation-save-uncertain');await page.getByRole('button',{name:'Reserve',exact:true}).click();await expect(page.getByRole('button',{name:'Check whether it was saved',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Reserve',exact:true})).toBeDisabled();assert.equal(await mutations(),bookingBefore+1);
  await mode('');await page.getByRole('button',{name:'Check whether it was saved',exact:true}).click();await expect(page.getByRole('heading',{name:'Session recovery reservation',exact:true})).toBeVisible();assert.equal(await mutations(),bookingBefore+1);
  console.log('PASS preflight blocks writes and keeps input; post-write uncertainty still reconciles without duplicate');
  await context.clearCookies();await context.addCookies([{name:'captain_session',value:'invalid-fixture-session',url:origin}]);await goto('/work');await expect(page).toHaveURL(/\/sign-in/);await expect(page.getByRole('link',{name:'Continue with Google'})).toBeVisible();
  await context.clearCookies();await goto('/work');await expect(page).toHaveURL(/\/sign-in/);
  assert.deepEqual(errors,[]);console.log('PASS real invalid-session 401 and missing-cookie sign-in behaviour, no browser exceptions');
 } catch(error) { await page.screenshot({path:path.join(directory,'failure.png'),fullPage:true}).catch(()=>{});throw error; }
 finally {await mode('');await context.close();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
