/** Local production web + workspace-fixture only (real API and Postgres). Private saved Work views (D26,
 *  contract §7/§11): create/open/rename/delete, explicit clears, two-tab stale drafts, uncertain creates,
 *  reference failures without broadening, unusable links, revocation, keyboard feedback and layouts.
 *
 *  Start the local fixture with WORKSPACE_PROBE_FAST_LIMITS=1: its controlled limiter clock avoids
 *  unrelated 429s from rapid test actions/revalidation. Auth, roles, RLS and writes still use the real services.
 *  Needs from the fixture (root-owned): data.json `memberToken`, `memberUserId`, `newerViewId` (an owner
 *  row with filter_version 2 inserted as the owner role), `unreadableViewId` (an owner row with filter_version 1
 *  and a filter that is not valid v1, e.g. {"owner":"me"}), and these `mode` values:
 *    views-list-failed, view-read-failed, view-references-unavailable, view-references-missing,
 *    view-save-uncertain, view-patch-uncertain, view-delete-uncertain (commit, then answer 503),
 *    view-patch-failed (answer 503 to PATCH …/views/:id without reaching the handler). */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:3034', directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw Error('WORKSPACE_PROBE_DIR required');
(async () => {
 const fixture = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(fixture.fixture, 'captain-workspace-local');
 assert.equal(fixture.fastRateWindows, true, 'saved-view fixture requires WORKSPACE_PROBE_FAST_LIMITS=1');
 for (const key of ['memberToken', 'memberUserId', 'newerViewId', 'unreadableViewId']) assert.ok(fixture[key], `fixture ${key} required for saved views`);
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 /** Every context signs in with a cookie and, when the shared Chrome runs in Docker (CHROME_CDP_URL), forwards
  *  loopback requests through Node, as workspace-check.cjs does, including HTTP redirects as fresh navigations. */
 const signedIn = async (token, initScript) => {
  const made = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (initScript) await made.addInitScript(initScript);
  if (process.env.CHROME_CDP_URL) await made.route(`${origin}/**`, async route => {
   const response = await route.fetch({ maxRedirects: 0 }), location = response.headers().location;
   if (location && response.status() >= 300 && response.status() < 400 && route.request().isNavigationRequest()) {
    const destination = new URL(location, route.request().url()).href;
    await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination).replace(/</g, '\\u003c')})</script>` });
   } else await route.fulfill({ response });
  });
  await made.addCookies([{ name: 'captain_session', value: token, url: origin }]);
  return made;
 };
 const context = await signedIn(fixture.token);
 const page = await context.newPage(), errors = []; page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
 // A second test tab can leave this page backgrounded in shared headed Chrome. Bring it forward for captures.
 const screenshot = async options => { await page.bringToFront(); return page.screenshot({ ...options, timeout: 30000 }); };
 // Pat (a plain member) has no saved views; the owner has the seeded newer/unreadable rows.
 const patContext = await signedIn(fixture.memberToken);
 const patPage = await patContext.newPage(); patPage.setDefaultTimeout(15000); patPage.on('pageerror', e => errors.push(e.message));
 const pause = () => new Promise(resolve => setTimeout(resolve, 1500));
 const goto = async (route, on = page) => { await pause(); return on.goto(origin + route); };
 const mode = value => writeFile(path.join(directory, 'mode'), value);
 const call = async (route, method = 'GET', body, token = fixture.token) => {
  const response = await fetch('http://127.0.0.1:8084' + fixture.base + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
 };
 const api = async (...args) => { const r = await call(...args); assert.ok(r.status < 300, `${args[1] ?? 'GET'} ${args[0]}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
 const myViews = async () => (await api('/views?limit=50')).views;
 const createView = (name, filter, token) => api('/views', 'POST', { id: randomUUID(), name, filter }, token);
 const params = (on = page) => new URL(on.url()).searchParams;
 const noOverflow = async (on = page) => assert.ok(await on.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${on.url()}`);
 const openFilter = async (on = page) => { await on.locator('.work-filters > details > summary').filter({ hasText: /^Filter$/ }).click(); };
 const main = (on = page) => on.locator('main');
 const production = fixture.productionId, sales = fixture.salesId;
 const productionOpen = { owner: 'all', status: 'open', tagIds: [production], projectId: null };
 try {
  await mode('');

  // Empty and failed list states, as Pat (no views); the fixed groups stay usable. Create tests then run as the owner.
  assert.equal((await api('/views?limit=50', 'GET', undefined, fixture.memberToken)).views.length, 0, 'Pat starts with no saved views');
  await goto('/work/views', patPage);
  const patSaved = patPage.getByRole('region', { name: 'Saved views' });
  await expect(patSaved.getByRole('heading', { name: 'No saved views yet' })).toBeVisible();
  await expect(patPage.getByRole('link', { name: /^My work/ })).toBeVisible();
  await mode('views-list-failed'); await goto('/work/views', patPage);
  await expect(patSaved.getByRole('alert')).toContainText('Your saved views could not be read');
  await expect(patPage.getByRole('link', { name: /^All tasks/ })).toBeVisible();
  await mode('');
  const savedGroup = page.getByRole('region', { name: 'Saved views' });
  console.log('PASS empty and failed Saved views states, fixed groups unaffected');

  // Create from a Work list with the keyboard; it opens with exactly the stored filter.
  await goto(`/work?owner=all&tagId=${production}`);
  await page.locator('summary').filter({ hasText: /^Save this view$/ }).click();
  await expect(page.locator('.work-save-view__words')).toContainText('Everyone · Tag: Production · Open · Any project');
  const nameField = page.getByLabel('View name', { exact: true });
  await nameField.focus(); await page.keyboard.type('Production'); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/work\?view=[0-9a-f-]{36}$/);
  const productionView = params().get('view');
  await expect(page.getByRole('heading', { level: 1, name: 'Production', exact: true })).toBeVisible();
  let stored = await api(`/views/${productionView}`);
  assert.deepEqual(stored.filter, productionOpen); assert.equal(stored.revision, 1);
  await expect(page.getByRole('link', { name: 'Confirm packaging slot' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call the stockist' })).toHaveCount(0);
  console.log('PASS keyboard create, exact stored filter, opened by id');

  // Listed, opened from the list, and My work stays the default.
  await goto('/work/views');
  const row = savedGroup.getByRole('link', { name: /^Production/ });
  await expect(row).toContainText('Tag: Production · Everyone · Open');
  await row.click(); await expect(page).toHaveURL(`${origin}/work?view=${productionView}`);
  await goto('/work'); await expect(page.getByRole('heading', { level: 1, name: 'My work', exact: true })).toBeVisible();
  console.log('PASS listed view opens; /work is still My work');

  // Keyboard completion inside a saved view keeps the view URL and focus feedback.
  await goto(`/work?view=${productionView}`);
  const box = page.getByRole('checkbox', { name: 'Complete Confirm packaging slot', exact: true });
  await box.focus(); await box.press('Space');
  await expect(page.getByRole('status', { name: 'Work updates' })).toContainText('Confirm packaging slot completed.');
  await expect(page.getByRole('status', { name: 'Work updates' })).toBeFocused();
  await expect(page).toHaveURL(`${origin}/work?view=${productionView}`);
  const packaging = (await api(`/tasks/${fixture.tasks['Confirm packaging slot']}`)).task;
  await api(`/tasks/${packaging.id}`, 'PATCH', { expectedRevision: packaging.revision, status: 'open' });
  console.log('PASS in-view task completion keeps the view and focus feedback');

  // Unusable and inconsistent links never fall back to another list.
  await goto(`/work?view=${productionView}&owner=me`);
  await expect(page.getByRole('heading', { name: 'This saved view link is inconsistent' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Confirm packaging slot' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Open the saved view unchanged' }).click();
  await expect(page).toHaveURL(`${origin}/work?view=${productionView}`);
  await goto(`/work?view=${randomUUID()}`);
  await expect(page.getByRole('heading', { name: 'This saved view is not available' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Show my work' })).toHaveAttribute('href', '/work');
  await goto('/work?view=not-a-view'); await expect(page.getByRole('heading', { name: 'This link could not be read' })).toBeVisible();
  // Hex-shaped but not an id the API accepts: the invalid-link state, not "could not be read" with Try again.
  await goto('/work?view=00000000-0000-0000-0000-000000000001'); await expect(page.getByRole('heading', { name: 'This link could not be read' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try again' })).toHaveCount(0);
  await goto(`/work?view=${fixture.newerViewId}`);
  await expect(page.getByRole('heading', { name: /needs a newer version of Captain/ })).toBeVisible();
  await expect(page.locator('.work-groups')).toHaveCount(0);
  await goto(`/work?view=${fixture.unreadableViewId}`);
  await expect(page.getByRole('heading', { name: /could not be read$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /newer version/ })).toHaveCount(0);
  await expect(page.locator('.work-groups')).toHaveCount(0);
  await mode('view-read-failed'); await goto(`/work?view=${productionView}`);
  await expect(main().getByRole('alert')).toContainText('This saved view could not be read');
  await expect(page.locator('.work-groups')).toHaveCount(0);
  await mode('');
  console.log('PASS inconsistent, unknown, invalid, newer-version and read-failure states are explicit');

  // Reference failures keep the exact stored filter; missing and unavailable read differently.
  await mode('view-references-unavailable'); await goto(`/work?view=${productionView}`);
  await expect(page.getByText('Tag names could not be read; the view still filters by them.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Confirm packaging slot' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call the stockist' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Team follow-up/ })).toHaveCount(0);
  await mode('view-references-missing'); await goto(`/work?view=${productionView}`);
  await expect(page.getByText(/A tag in this view no longer exists\. The view still filters by it/)).toBeVisible();
  await expect(page.locator('.work-filters__active')).toContainText('Missing tag');
  await expect(page.getByRole('link', { name: 'Call the stockist' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Team follow-up/ })).toHaveCount(0);
  await mode('');
  assert.deepEqual((await api(`/views/${productionView}`)).filter, productionOpen);
  console.log('PASS unavailable and missing references stay distinct and never broaden the list');

  // Explicit clears through chips, paging and history keep the original base, then save.
  const launch = await createView('Launch', { owner: 'all', status: 'all', tagIds: [production, sales], projectId: fixture.projectId });
  await goto(`/work?view=${launch.id}`);
  await page.getByRole('link', { name: 'Remove the project filter' }).click();
  await expect(page).toHaveURL(/draft=1/);
  assert.equal(params().get('base'), '1'); assert.equal(params().get('projectId'), 'none'); assert.equal(params().getAll('tagId').length, 2);
  await expect(page.getByRole('region', { name: 'Unsaved changes to this view' })).toContainText('Changed from Launch');
  for (const name of ['Production', 'Sales']) {
   await page.getByRole('link', { name: `Remove the tag filter ${name}` }).click();
   await expect(page.getByRole('link', { name: `Remove the tag filter ${name}` })).toHaveCount(0);
  }
  assert.deepEqual(params().getAll('tagId'), ['none']); assert.equal(params().get('base'), '1');
  const clearedDraft = page.url();
  await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Next' }).click();
  await expect(page).toHaveURL(/offset=50/);
  assert.equal(params().get('base'), '1'); assert.deepEqual(params().getAll('tagId'), ['none']); assert.equal(params().get('projectId'), 'none');
  await page.goBack(); await expect(page).toHaveURL(clearedDraft);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/work?view=${launch.id}`);
  stored = await api(`/views/${launch.id}`);
  assert.deepEqual(stored.filter, { owner: 'all', status: 'all', tagIds: [], projectId: null }); assert.equal(stored.revision, 2);
  console.log('PASS explicit tag/project clears survive paging and history and save as cleared');

  // The no-JS filter form becomes a complete draft; Discard returns to the stored filter.
  await openFilter(); await page.getByLabel('Status', { exact: true }).selectOption('done');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page).toHaveURL(/draft=1/);
  assert.equal(params().get('status'), 'done'); assert.equal(params().get('base'), '2'); assert.equal(params().get('tagId'), 'none'); assert.equal(params().get('projectId'), 'none'); assert.equal(params().get('edit'), null);
  await page.getByRole('link', { name: 'Discard', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/work?view=${launch.id}`);
  assert.equal((await api(`/views/${launch.id}`)).revision, 2);
  console.log('PASS form edits produce complete drafts; Discard changes nothing');

  // Two tabs: B saves, A keeps editing from its original base, and A's save is refused and compared.
  const twoTabs = await createView('Two tabs', productionOpen);
  const pageB = await context.newPage(); pageB.setDefaultTimeout(15000); pageB.on('pageerror', e => errors.push(e.message));
  await goto(`/work?view=${twoTabs.id}`); await goto(`/work?view=${twoTabs.id}`, pageB);
  await openFilter(pageB); await pageB.getByLabel('Status', { exact: true }).selectOption('done'); await pageB.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(pageB).toHaveURL(/draft=1/);
  await pageB.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(pageB).toHaveURL(`${origin}/work?view=${twoTabs.id}`);
  assert.equal((await api(`/views/${twoTabs.id}`)).revision, 2);
  await openFilter(); await page.getByLabel('Owner', { exact: true }).selectOption('me'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page).toHaveURL(/draft=1/); assert.equal(params().get('base'), '1');
  await page.getByRole('link', { name: 'Remove the tag filter Production' }).click();
  await expect(page).toHaveURL(/tagId=none/); assert.equal(params().get('base'), '1');
  const draftBar = page.getByRole('region', { name: 'Unsaved changes to this view' });
  await draftBar.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(draftBar.getByRole('alert')).toContainText('changed in another tab');
  const compare = draftBar.getByRole('group', { name: 'Saved filter and your draft' });
  await expect(compare.locator('div').filter({ hasText: /^Saved now/ }).locator('dd')).toContainText('Done');
  await expect(compare.locator('div').filter({ hasText: /^Your draft/ }).locator('dd')).toContainText('Assigned to you · Any tag · Open');
  stored = await api(`/views/${twoTabs.id}`);
  assert.equal(stored.revision, 2); assert.deepEqual(stored.filter, { ...productionOpen, status: 'done' });
  assert.equal(params().get('base'), '1');
  for (const width of [360, 390, 430, 1440]) { await page.setViewportSize({ width, height: 874 }); await noOverflow(); await screenshot({ path: path.join(directory, `saved-view-conflict-${width}.png`), fullPage: true }); }
  await page.setViewportSize({ width: 390, height: 844 });
  // A Replace that fails without landing is checked against the revision it was sent with (2), not the base (1).
  const replace = draftBar.getByRole('button', { name: 'Replace the saved filter with my draft', exact: true });
  await mode('view-patch-failed'); await replace.click();
  await expect(draftBar.getByRole('alert')).toContainText('could not confirm');
  await mode(''); await draftBar.getByRole('button', { name: 'Check whether it saved', exact: true }).click();
  await expect(draftBar.getByText('The saved filter was not replaced. Nothing changed', { exact: false })).toBeVisible();
  await expect(draftBar.getByText('changed elsewhere, and not to your draft', { exact: false })).toHaveCount(0);
  assert.equal((await api(`/views/${twoTabs.id}`)).revision, 2);
  // Its retry uses the same sent revision and lands.
  await mode('view-patch-failed'); await replace.click();
  await expect(draftBar.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await mode(''); await draftBar.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/work?view=${twoTabs.id}`);
  stored = await api(`/views/${twoTabs.id}`);
  assert.equal(stored.revision, 3); assert.deepEqual(stored.filter, { owner: 'me', status: 'open', tagIds: [], projectId: null });
  await pageB.close();
  console.log('PASS two-tab stale draft keeps base, shows both filters, overwrites nothing until explicitly replaced');

  // Uncertain create: inputs lock; a same-id retry creates exactly one view.
  const named = async name => (await myViews()).filter(v => v.name === name);
  await goto('/work?owner=all&status=done');
  await page.locator('summary').filter({ hasText: /^Save this view$/ }).click();
  await page.getByLabel('View name', { exact: true }).fill('Done work');
  await mode('view-save-uncertain'); await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(main().getByRole('alert')).toContainText('could not confirm');
  await expect(page.getByLabel('View name', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('View name', { exact: true })).toHaveValue('Done work');
  const [landed] = await named('Done work'); assert.ok(landed, 'the uncertain save committed in the fixture');
  const pendingKey = `captain.savedViewCreate.v1.${fixture.userId.toLowerCase()}.${fixture.orgId.toLowerCase()}`;
  const kept = JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), pendingKey));
  assert.equal(kept.id, landed.id); assert.equal(kept.name, 'Done work'); assert.equal(JSON.stringify(kept).match(/token|session/i), null);
  // Reload while uncertain, and on a different filter: the identity is restored and stays locked.
  await mode(''); await goto('/work?owner=all&status=all');
  await expect(main().getByRole('alert')).toContainText('has not confirmed whether “Done work” was saved');
  await expect(page.getByLabel('View name', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('View name', { exact: true })).toHaveValue('Done work');
  await expect(page.locator('.work-save-view__words')).toContainText('Everyone · Any tag · Done · Any project');
  await expect(page.getByRole('button', { name: 'Save view', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/work?view=${landed.id}`);
  assert.equal((await named('Done work')).length, 1);
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null, 'resolved create is cleared from the tab');
  // Reconcile by reading the same id.
  await goto('/work?status=all');
  await page.locator('summary').filter({ hasText: /^Save this view$/ }).click();
  await page.getByLabel('View name', { exact: true }).fill('Everything mine');
  await mode('view-save-uncertain'); await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check whether it saved', exact: true })).toBeVisible();
  await mode(''); await page.getByRole('button', { name: 'Check whether it saved', exact: true }).click();
  const [checked] = await named('Everything mine');
  await expect(page).toHaveURL(`${origin}/work?view=${checked.id}`);
  assert.equal((await named('Everything mine')).length, 1);
  // Changed elsewhere after an uncertain save: the id is unavailable; only an explicit new save gets a new id.
  await goto('/work?owner=all&status=suggested');
  await page.locator('summary').filter({ hasText: /^Save this view$/ }).click();
  await page.getByLabel('View name', { exact: true }).fill('Suggestions');
  await mode('view-save-uncertain'); await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await mode('');
  const [suggestions] = await named('Suggestions');
  await api(`/views/${suggestions.id}`, 'PATCH', { expectedRevision: suggestions.revision, name: 'Suggestions (renamed)' });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(main().getByRole('alert')).toContainText('reserved identity');
  assert.equal((await myViews()).filter(v => v.name.startsWith('Suggestions')).length, 1);
  await page.getByRole('button', { name: 'Save as a new view', exact: true }).click();
  await page.getByLabel('View name', { exact: true }).fill('Suggestions again');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page).toHaveURL(/\/work\?view=/);
  assert.notEqual(params().get('view'), suggestions.id);
  console.log('PASS uncertain creates lock, retry/reconcile the same id, and only an explicit new save gets a new id');

  // A tab that cannot keep a create's identity refuses the save before any request, and says so; retry stays refused.
  const stats = async () => (await fetch('http://127.0.0.1:8084/__fixture/stats')).json();
  for (const [label, block] of [
   ['blocked', () => { Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError'); } }); }],
   ['full', () => { Storage.prototype.setItem = function () { throw new DOMException('Full', 'QuotaExceededError'); }; }]
  ]) {
   const blockedContext = await signedIn(fixture.token, block);
   const blockedPage = await blockedContext.newPage(); blockedPage.setDefaultTimeout(15000);
   const actionPosts = [];
   blockedPage.on('request', request => { if (request.method() === 'POST' && request.headers()['next-action']) actionPosts.push(request.url()); });
   await goto('/work?owner=all&status=cancelled', blockedPage);
   await blockedPage.locator('summary').filter({ hasText: /^Save this view$/ }).click();
   await expect(blockedPage.getByRole('button', { name: 'Save view', exact: true })).toBeEnabled();
   const before = (await stats()).mutationRequests;
   await blockedPage.getByLabel('View name', { exact: true }).fill(`Blocked ${label}`);
   for (let attempt = 0; attempt < 2; attempt++) {
    await blockedPage.getByRole('button', { name: 'Save view', exact: true }).click();
    await expect(blockedPage.locator('main').getByRole('alert')).toContainText('Nothing was saved. This tab is not letting Captain keep');
    await expect(blockedPage.getByLabel('View name', { exact: true })).toBeEditable();
   }
   await pause();
   assert.deepEqual(actionPosts, [], `${label}: no server action was called`);
   assert.equal((await stats()).mutationRequests, before, `${label}: no API write was made`);
   assert.equal((await named(`Blocked ${label}`)).length, 0);
   await blockedContext.close();
  }
  console.log('PASS unavailable or full tab storage refuses a new create with zero requests');

  // An unreadable pending record keeps the form locked until the person explicitly starts a new view.
  await goto('/work?owner=all');
  await page.evaluate(key => sessionStorage.setItem(key, '{"v":1,"broken":true}'), pendingKey);
  const beforeInvalid = (await stats()).mutationRequests;
  await page.reload();
  await expect(main().getByRole('alert')).toContainText('holds an unconfirmed save that Captain cannot read');
  await expect(page.getByRole('button', { name: 'Save view', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('View name', { exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Check saved views', exact: true })).toHaveAttribute('href', '/work/views');
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), '{"v":1,"broken":true}', 'not cleared automatically');
  await page.getByRole('button', { name: 'Start a new view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save view', exact: true })).toBeEnabled();
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null);
  assert.equal((await stats()).mutationRequests, beforeInvalid);
  console.log('PASS an unreadable pending record locks until an explicit start-new choice');

  // Scope: a tab rendered for organisation A never writes into organisation B after the shared cookie changes.
  const second = await (await fetch('http://127.0.0.1:8084/v1/organisations', { method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Second bakery' }) })).json();
  assert.ok(second.id, 'second organisation for the owner');
  const secondViews = async () => (await (await fetch(`http://127.0.0.1:8084/v1/organisations/${second.id}/views?limit=50`, { headers: { authorization: `Bearer ${fixture.token}` } })).json()).views;
  const useOrganisation = id => context.addCookies([{ name: 'captain_organisation', value: id, url: origin }]);
  await useOrganisation(fixture.orgId);
  // A fresh create in an A page after B becomes active: refused before any API call, and not left pending.
  await goto('/work?owner=all&status=in_progress');
  await page.locator('summary').filter({ hasText: /^Save this view$/ }).click();
  await page.getByLabel('View name', { exact: true }).fill('Scope fresh');
  await useOrganisation(second.id);
  let before = (await stats()).mutationRequests;
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(main().getByRole('alert')).toContainText('opened for a different sign-in or organisation');
  await expect(page.getByRole('button', { name: 'Reload this page', exact: true })).toBeVisible();
  assert.equal((await stats()).mutationRequests, before);
  assert.equal((await named('Scope fresh')).length, 0); assert.equal((await secondViews()).length, 0);
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null);
  // An unconfirmed A create stays A's: its retry is refused in B, the lock and record survive, and it resolves in A.
  await useOrganisation(fixture.orgId);
  await goto('/work?owner=all&status=in_progress');
  await page.locator('summary').filter({ hasText: /^Save this view$/ }).click();
  await page.getByLabel('View name', { exact: true }).fill('Scope check');
  await mode('view-save-uncertain'); await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await mode('');
  const [scoped] = await named('Scope check'); assert.ok(scoped);
  await useOrganisation(second.id);
  before = (await stats()).mutationRequests;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(main().getByRole('alert')).toContainText('opened for a different sign-in or organisation');
  await expect(page.getByLabel('View name', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: 'Check whether it saved', exact: true })).toBeVisible();
  assert.equal((await stats()).mutationRequests, before); assert.equal((await secondViews()).length, 0);
  assert.equal(JSON.parse(await page.evaluate(key => sessionStorage.getItem(key), pendingKey)).id, scoped.id);
  await page.reload();
  await page.locator('summary').filter({ hasText: /^Save this view$/ }).click();
  await expect(page.getByRole('button', { name: 'Save view', exact: true })).toBeEnabled(); // B has nothing pending
  await expect(page.getByText('Scope check')).toHaveCount(0);
  await useOrganisation(fixture.orgId); await page.reload();
  await expect(page.getByLabel('View name', { exact: true })).toHaveValue('Scope check');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/work?view=${scoped.id}`);
  assert.equal((await named('Scope check')).length, 1); assert.equal((await secondViews()).length, 0);
  // Rename in an A view page after B becomes active is refused too, and nothing changes.
  await page.locator('summary').filter({ hasText: /^Rename or delete this view$/ }).click();
  await page.getByLabel('Name', { exact: true }).fill('Scope renamed');
  await useOrganisation(second.id);
  before = (await stats()).mutationRequests;
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(main().getByRole('alert')).toContainText('opened for a different sign-in or organisation');
  assert.equal((await stats()).mutationRequests, before); assert.equal((await api(`/views/${scoped.id}`)).name, 'Scope check');
  await useOrganisation(fixture.orgId);
  console.log('PASS saved-view actions refuse a different active organisation; pending creates stay scoped');

  // Client state belongs to one draft: a new draft URL for the same view and base starts clean, base unchanged.
  const keyed = await createView('Keyed draft', productionOpen);
  await goto(`/work?view=${keyed.id}`);
  await openFilter(); await page.getByLabel('Status', { exact: true }).selectOption('done'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page).toHaveURL(/draft=1/);
  const keyedBar = page.getByRole('region', { name: 'Unsaved changes to this view' });
  await mode('view-patch-failed'); await keyedBar.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(keyedBar.getByRole('alert')).toContainText('could not confirm'); await mode('');
  await page.getByRole('link', { name: 'Remove the tag filter Production' }).click();
  await expect(page).toHaveURL(/tagId=none/); assert.equal(params().get('base'), '1');
  await expect(keyedBar.getByRole('alert')).toHaveCount(0);
  await expect(keyedBar.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
  // The filter form follows the new draft after client navigation (no stale checks from the previous URL).
  await expect(page.locator(`.work-filters__form input[name="tagId"][value="${production}"]`)).not.toBeChecked();
  await expect(page.locator('#work-status')).toHaveValue('done');
  await expect(page.locator('.work-filters__form input[name="base"]')).toHaveValue('1');
  console.log('PASS draft and filter-form state are keyed to the draft; base is kept');

  // Rename and delete, including an uncertain delete reconciled by reading.
  await goto(`/work?view=${productionView}`);
  await page.locator('summary').filter({ hasText: /^Rename or delete this view$/ }).click();
  // The rename lands but its answer is lost; the retry comes back stale and is recognised as the same save.
  await page.getByLabel('Name', { exact: true }).fill('Production line');
  await mode('view-patch-uncertain'); await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check whether it was renamed', exact: true })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('readonly', '');
  await mode(''); await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Production line', exact: true })).toBeVisible();
  await expect(page.getByText('Reload it to see the latest version', { exact: false })).toHaveCount(0);
  assert.equal((await api(`/views/${productionView}`)).name, 'Production line');
  await page.getByRole('button', { name: 'Delete view…', exact: true }).click();
  await mode('view-delete-uncertain'); await page.getByRole('button', { name: 'Delete “Production line”', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check whether it was deleted', exact: true })).toBeVisible();
  await mode(''); await page.getByRole('button', { name: 'Check whether it was deleted', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/work/views`);
  await expect(savedGroup.getByRole('link', { name: /^Production line/ })).toHaveCount(0);
  assert.equal((await call(`/views/${productionView}`)).status, 404);
  await goto(`/work?view=${productionView}`); await expect(page.getByRole('heading', { name: 'This saved view is not available' })).toBeVisible();
  console.log('PASS rename; uncertain delete reconciled; deleted id is not available');

  // Privacy and revocation: another member's view is indistinguishable from an unknown one.
  const theirs = await createView('Pat private', productionOpen, fixture.memberToken);
  await goto(`/work?view=${theirs.id}`);
  await expect(page.getByRole('heading', { name: 'This saved view is not available' })).toBeVisible();
  await expect(page.getByText('Pat private')).toHaveCount(0);
  await goto(`/work?view=${theirs.id}`, patPage); await expect(patPage.getByRole('heading', { level: 1, name: 'Pat private', exact: true })).toBeVisible();

  // Populated layouts before revocation changes the organisation.
  for (const [name, route] of [['views', '/work/views'], ['saved', `/work?view=${launch.id}`], ['draft', `/work?view=${launch.id}&base=2&draft=1&owner=me&status=open&tagId=${production}&projectId=none`]]) {
   for (const width of [360, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 874 }); await goto(route); await noOverflow();
    await screenshot({ path: path.join(directory, `saved-${name}-${width}.png`), fullPage: true });
   }
  }
  await page.setViewportSize({ width: 390, height: 844 });

  await api(`/members/${fixture.memberUserId}`, 'DELETE');
  await goto(`/work?view=${theirs.id}`, patPage);
  await expect(patPage.getByText('Pat private')).toHaveCount(0);
  await expect(patPage.locator('.work-groups')).toHaveCount(0);
  console.log('PASS other members\' views are private; revoked membership loses access; 360/390/430/1440 layouts');

  assert.deepEqual(errors, []);
 } catch (error) { await screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }).catch(() => {}); console.error('PAGE', page.url(), await page.locator('main').innerText().catch(() => '')); throw error; }
 finally { await mode('').catch(() => {}); await patContext.close().catch(() => {}); await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
