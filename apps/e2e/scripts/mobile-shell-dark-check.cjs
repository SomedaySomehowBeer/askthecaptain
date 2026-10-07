/** Colour scheme: the harness's synthetic scenarios rendered with `prefers-color-scheme` emulated as dark and as light.
 *  Checks the pre-paint page background, the theme-color metas, and the page and card surfaces on the thread list, a
 *  thread, the new-thread screen, settings and the equipment schedule. A browser approximation only: not native
 *  appearance, not assistive technology. */
const { expect } = require('@playwright/test'); const path = require('node:path');
const tokens = {
 light: { page: 'rgb(241, 245, 238)', card: 'rgb(255, 255, 255)', unknown: 'rgba(84, 101, 90, 0.1)', heading: 'rgb(20, 38, 25)' },
 dark: { page: 'rgb(15, 26, 20)', card: 'rgb(23, 35, 28)', unknown: 'rgba(169, 182, 171, 0.1)', heading: 'rgb(244, 247, 242)' }
};
const tid = '00000000-0000-4000-8000-000000000011';
module.exports = async ({ browser, base, shots, width }) => {
 for (const scheme of ['dark', 'light']) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, hasTouch: width < 500 });
  try {
   const page = await context.newPage(); page.setDefaultTimeout(15000); const errors = [], outside = [];
   page.on('pageerror', error => errors.push(error.message));
   await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin !== base.origin) { outside.push(url.origin); return route.abort(); } return route.continue(); });
   const want = tokens[scheme];
   const id = name => page.getByTestId(name).filter({ visible: true });
   /** The colour actually painted behind an element: its own background or the nearest ancestor's that is not transparent. */
   const behind = locator => locator.first().evaluate(el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; } return null; });
   const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-${scheme}-${name}.png`), fullPage: true }); };
   const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
   const open = async (route, name) => { await page.goto(new URL(`${route}${route.includes('?') ? '&' : '?'}scenario=${name}`, base).href); await expect(page.getByTestId('harness-scenario')).toHaveText(name); };
   const heading = text => page.getByRole('heading', { name: text, exact: true });

   // Before React paints: the document itself is the scheme's page colour, so dark mode has no white flash.
   await page.goto(new URL('/?scenario=threads-loaded', base).href, { waitUntil: 'commit' });
   await page.waitForSelector('#root', { state: 'attached' });
   expect(await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor])).toEqual([want.page, want.page]);
   const metas = await page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map(m => [m.media, m.content]));
   expect(metas).toEqual([['(prefers-color-scheme: light)', '#f1f5ee'], ['(prefers-color-scheme: dark)', '#0f1a14']]);
   expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(scheme === 'dark');

   // Thread list: page behind the heading, a white/dark card for an unselected filter, the heading's own colour.
   await open('/', 'threads-loaded'); await expect(id(`thread-row-${tid}`)).toBeVisible();
   expect(await behind(heading('Threads'))).toBe(want.page); expect(await behind(id('threads-filter-1').locator(':scope > *'))).toBe(want.card);
   expect(await heading('Threads').evaluate(el => getComputedStyle(el).color)).toBe(want.heading);
   await overflow(); await shot('list');

   // A thread: the record card and the page around it.
   await open(`/threads/${tid}`, 'threads-loaded'); await expect(id('thread-card')).toBeVisible(); await expect(id('thread-unread-line')).toBeVisible();
   expect(await behind(id('thread-card'))).toBe(want.card); expect(await behind(id('thread-card').locator('..'))).toBe(want.page);
   await overflow(); await shot('thread');

   // New thread: the composer row is a card on the page.
   await open('/threads/new', 'threads-new'); await expect(id('new-thread-body')).toBeVisible();
   expect(await behind(heading('New thread'))).toBe(want.page); expect(await behind(id('new-thread-body'))).toBe(want.card);
   await overflow(); await shot('new');

   // Settings: the account card.
   await open('/settings', 'passkeys-loaded'); await expect(heading('Account')).toBeVisible(); await expect(id('account-organisation')).toBeVisible();
   expect(await behind(heading('Account'))).toBe(want.page); expect(await behind(id('account-organisation'))).toBe(want.card);
   await overflow(); await shot('settings');

   // Equipment schedule: organisation, page 0 and one occupancy answer; unknown time keeps its tint, unlike read (free) time.
   await open('/equipment', 'ready'); await expect(heading('Equipment schedule')).toBeVisible();
   const reads = async () => JSON.parse(await page.getByTestId('work-read-log').textContent());
   const answer = async (n, control) => { await expect.poll(async () => (await reads()).length).toBeGreaterThanOrEqual(n); await page.getByTestId(`harness-read-${control}`).click(); };
   await answer(1, 'equipment-ok'); await answer(2, 'equipment-ok'); await expect(id('equipment-hatch').first()).toBeVisible();
   await answer(3, 'equipment-ok'); await expect(page.locator('[data-testid^="equipment-bar-"]:visible').first()).toBeVisible();
   await expect(id('equipment-read').first()).toBeAttached();
   expect(await behind(heading('Equipment schedule'))).toBe(want.page); expect(await behind(id('equipment-scale-hours'))).toBe(want.card);
   expect(await behind(id('equipment-read'))).toBe(want.page);
   expect(await id('equipment-hatch').first().evaluate(el => getComputedStyle(el.parentElement).backgroundColor)).toBe(want.unknown);
   await overflow(); await shot('equipment');

   expect(errors).toEqual([]); expect(outside).toEqual([]);
   console.log(`PASS ${width}px ${scheme}: pre-paint background and theme-color, page and card tokens on the thread list, thread, new thread, settings and equipment schedule`);
  } finally { await context.close(); }
 }
};
