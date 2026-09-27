/** Inventory: production parser, list and UI over explicit synthetic answers, not native/device proof. */
const { expect } = require('@playwright/test');
module.exports = async ({getPage,freshPage,scenario,shot,noOverflow,width}) => {
 const page=()=>getPage();
 const id=name=>page().locator(`[data-testid="${name}"]:visible`);
 const stock=name=>id(`stock-${name}`);
 const rows=()=>page().locator('[data-testid^="stock-row-"]:visible');
 const row=n=>stock(`row-00000000-0000-4000-a000-${String(n).padStart(12,'0')}`);
 const log=async()=>JSON.parse(await page().getByTestId('work-read-log').textContent());
 const count=async n=>expect.poll(async()=>(await log()).length).toBe(n);
 const answer=async name=>page().getByTestId(`harness-read-${name}`).click();
 const start=async(freeze=false)=>{
  await freshPage();
  if(freeze){await page().clock.install();await page().clock.pauseAt(await page().evaluate(()=>Date.now()));}
  await scenario('ready','/resources/inventory');
  await expect(page().getByRole('heading',{name:'Inventory',exact:true})).toBeVisible();
  await expect(stock('loading')).toHaveText('Loading stock…');await count(1);
  const url=new URL((await log()).at(-1).path,'https://example.invalid');
  expect(url.pathname).toMatch(/^\/v1\/organisations\/[0-9a-f-]+\/stock$/);expect(url.search).toBe('');
 };
 await start();await answer('stock-malformed');
 await expect(stock('problem')).toContainText("Couldn't load the stock list.");await expect(stock('empty')).toHaveCount(0);
 await stock('try-again').click();await count(2);await answer('empty');
 await expect(stock('empty')).toContainText('No stock items are listed yet.');
 await stock('refresh').click();await count(3);await answer('ok-page');await expect(rows()).toHaveCount(3);
 await expect(row(1)).toContainText('12.50 bags');await expect(row(1)).toContainText('Reorder point: 15.000 bags');
 await expect(row(1)).toContainText('Below reorder point');await expect(row(2)).toContainText('Not counted yet.');
 await expect(row(3)).toContainText('24 kegs');
 expect(await page().locator('[data-testid^="stock-group-"]:visible').allTextContents()).toEqual(['Store','Packing','Cellar']);
 await noOverflow('loaded Inventory');await shot('stock-loaded');
 await stock('refresh').click();await count(4);await answer('unavailable');await expect(rows()).toHaveCount(3);
 await expect(stock('problem')).toContainText("Couldn't refresh. This list may be out of date.");
 await stock('try-again').click();await count(5);await answer('stock-uncounted');await expect(rows()).toHaveCount(1);
 await expect(row(4)).toContainText('Not counted yet.');await expect(stock('empty')).toHaveCount(0);
 await stock('refresh').click();await count(6);await answer('stock-unusual');await expect(rows()).toHaveCount(3);
 await expect(row(5)).toContainText('0.125 kg');await expect(row(6)).toContainText('12.50 kegs');
 await row(7).scrollIntoViewIfNeeded();await expect(row(7)).toContainText('9'.repeat(80));await noOverflow('long Inventory text');await shot('stock-exact-counts');
 await page().evaluate(()=>{window.__opened=[];window.open=url=>{window.__opened.push(String(url));return null;};});
 await stock('web').click();expect(await page().evaluate(()=>window.__opened)).toEqual(['https://app.example.invalid/resources/inventory']);
 await start(true);await answer('unavailable-wait');await expect(stock('try-again')).toBeDisabled();
 await page().clock.runFor(4999);await expect(stock('try-again')).toBeDisabled();await count(1);
 await page().clock.runFor(1);await expect(stock('try-again')).toBeEnabled();await count(1);
 await page().clock.resume();await stock('try-again').click();await count(2);await answer('ok-page');await expect(rows()).toHaveCount(3);
 await start();await answer('refused-404');await expect(stock('problem')).toContainText("Captain couldn't read this organisation's stock.");await expect(stock('empty')).toHaveCount(0);await count(1);
 for(const transition of ['switch','lost-single']){
  await start();await answer('ok-page');await expect(rows()).toHaveCount(3);await stock('refresh').click();await count(2);
  const epoch=(await log()).at(-1).epoch;
  await page().getByTestId(`harness-transition-${transition}`).click();await count(3);await expect(rows()).toHaveCount(0);
  expect((await log()).at(-1).epoch).not.toBe(epoch);
  await answer('ok-page');await expect(rows()).toHaveCount(0);await expect(page().locator('[data-testid^="work-row-"]:visible')).toHaveCount(0);
  await answer('ok-last');await expect(page().locator('[data-testid^="work-row-"]:visible')).toHaveCount(3);await count(3);
 }
 console.log(`PASS ${width}px: Inventory exact counts, raw API order, empty/error/refresh/wait, fixed website link and stale scope suppression`);
};
