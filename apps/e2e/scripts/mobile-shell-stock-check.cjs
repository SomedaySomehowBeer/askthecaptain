/** H3 (docs/plans/stock-2026-10.md §3, §4; design board 12): the Stock filter's pinned "Stocktake · n items" row;
 *  Stocktake grouped by location (type two, skip the rest, save once; the change lines appear in each counted item's
 *  thread); typed counts kept on leaving and returning; a stale item marked with the rest kept; an uncertain save locked
 *  until an explicit "Save again with the same ID", which sends the same body; "Add an item" in place; the stock card's
 *  details, last counts, Stocktake link and "Archive this item" with its confirm step; Show archived and Restore.
 *  Production export with synthetic, contract-shaped API answers (shapes from apps/api/src/{threads,stock};
 *  apps/api/src/stock/client.test.ts feeds the real ones through the same parsers). Every write is recorded: one request
 *  per press, the client's change set id, the exact body on an explicit retry. Not hosted, native or assistive technology. */
const { expect } = require('@playwright/test'); const path = require('node:path');
module.exports = async ({ browser, production, shots, width, scheme = 'light' }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, colorScheme: scheme });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const user = uuid(1), org = uuid(2), maya = uuid(41), tom = uuid(42);
  const at = '2026-09-01T00:00:00.000Z', zone = 'Australia/Sydney', monday = '2026-09-27T23:10:00.000Z', earlier = '2026-09-20T23:00:00.000Z';
  const people = { [user]: 'Sam Skipper', [maya]: 'Maya Chen', [tom]: 'Tom Reilly' };
  const writes = [], errors = [], outside = [];
  let mode = {}, seq = 0, made = 0;
  const once = key => { const m = mode[key]; delete mode[key]; return m; };
  const item = (n, name, location, unitLabel, currentCount, countedAt, countedBy) => ({ id: uuid(100 + n), organisationId: org, name, location, unitLabel, currentCount, countedAt: currentCount === null ? null : countedAt,
   countedBy: currentCount === null ? null : countedBy, reorderPoint: null, preferredSupplierId: null, notes: '', archivedAt: null, createdAt: at, updatedAt: at, revision: 2, thread: uuid(200 + n), history: [] });
  const items = [item(1, 'Pale malt', 'Cool room', 'bags', '11', monday, tom), item(2, 'Wheat malt', 'Cool room', 'bags', '4', monday, tom), item(3, 'Citra hops', 'Cool room', 'kg', '2.5', earlier, maya),
   item(4, '330 ml cans', 'Packaging store', 'cans', '4200', monday, tom), item(5, 'Pallet wrap', 'Packaging store', 'rolls', '1', monday, tom), item(6, 'Summer lager labels', 'Packaging store', 'sheets', null)];
  for (const i of items) if (i.currentCount !== null) i.history.push({ id: uuid(300 + ++seq), itemId: i.id, count: i.currentCount, note: '', countedAt: i.countedAt, countedBy: i.countedBy, countedByName: people[i.countedBy] });
  const [pale, wheat, citra, cans, wrap, labels] = items;
  const messages = Object.fromEntries(items.map(i => [i.thread, []]));
  const row = i => { const { thread: _t, history: _h, ...r } = i; return r; };
  const listed = i => ({ ...row(i), countedByName: i.countedBy ? people[i.countedBy] : null, supplierName: null, belowReorder: i.currentCount === null || i.reorderPoint === null ? null : Number(i.currentCount) < Number(i.reorderPoint) });
  const active = () => items.filter(i => i.archivedAt === null);
  const locations = () => [...new Set(active().map(i => i.location))].sort();
  const line = (thread, actor, changes, changeSetId) => { const list = messages[thread], n = list.length + 1, createdAt = new Date().toISOString().replace(/\.\d+Z$/, '.000Z');
   list.push({ id: uuid(1000 + ++seq), threadId: thread, kind: 'change', seq: n, changeSeq: n, authorId: actor, authorName: people[actor], body: null, createdAt, editedAt: null, deletedAt: null, deletedBy: null, revision: 1,
    changeSetId, change: { actorKind: 'person', actorId: actor, actorName: people[actor], causeKind: 'request', createdAt, changes, truncated: false } }); };
  const change = (i, c) => ({ id: uuid(3000 + ++seq), recordKind: 'stock_item', recordId: i.id, operation: 'update', field: null, itemKind: null, itemId: null, before: null, after: null, ...c });
  const count = (i, value, actor, changeSetId) => {
   const before = i.currentCount, countedAt = new Date(Date.now() + seq * 1000).toISOString();
   i.history.unshift({ id: uuid(300 + ++seq), itemId: i.id, count: value, note: '', countedAt, countedBy: actor, countedByName: people[actor] });
   line(i.thread, actor, [change(i, { field: 'currentCount', before, after: value }), change(i, { field: 'countedAt', before: i.countedAt, after: countedAt }), change(i, { field: 'countedBy', before: i.countedBy, after: actor })], changeSetId);
   Object.assign(i, { currentCount: value, countedAt, countedBy: actor, revision: i.revision + 1 });
  };
  const fold = i => ({ location: i.location, unitLabel: i.unitLabel, currentCount: i.currentCount, countedAt: i.countedAt, reorderPoint: i.reorderPoint, notes: i.notes, archivedAt: i.archivedAt, open: null });
  const threadRow = i => ({ id: i.thread, kind: 'record', title: i.name, record: { kind: 'stock', id: i.id }, facts: [i.currentCount === null ? 'Not counted' : `${i.currentCount} ${i.unitLabel}`, i.countedAt ? i.countedAt.slice(0, 10) : 'Never counted'],
   status: i.currentCount === null ? 'not_counted' : 'counted', lastMessageAt: at, lastMessage: null, unread: 0, needsYou: false, starred: false, tags: [] });
  const taken = new Map();
  await context.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (url.origin !== production.origin) { outside.push(url.origin); return route.abort(); }
   const json = (status, value, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(value) });
   if (!url.pathname.startsWith('/v1/')) { const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1'; return route.fetch({ url: upstream.href, maxRedirects: 0 }).then(response => route.fulfill({ response })).catch(() => {}); }
   expect(req.headers()['x-captain-client']).toBe('web');
   const p = url.pathname.replace(`/v1/organisations/${org}`, ''), method = req.method(), body = req.postData() ? req.postDataJSON() : undefined;
   if (method !== 'GET') writes.push({ method, path: p, body });
   if (url.pathname === '/v1/me') return json(200, { user: { id: user, name: 'Sam Skipper', email: 'sam@example.test' }, memberships: [{ organisationId: org, organisationName: 'Harbour Brewing', role: 'member', status: 'active' }], passkeyVerified: true });
   if (url.pathname === '/v1/me/passkeys') return json(200, { available: false, passkeys: [] });
   if (p === '') return json(200, { id: org, name: 'Harbour Brewing', timezone: zone, locale: 'en-AU', createdAt: at, role: 'member' });
   if (p === '/members') return json(200, { members: [user, maya, tom].map(userId => ({ userId, name: people[userId], email: `${userId.slice(-2)}@example.test`, role: 'member', status: 'active', since: at })) });
   if (p === '/tags') return json(200, { tags: [], nextOffset: null });
   if (p === '/threads' && method === 'GET') {
    const filter = url.searchParams.get('filter') || 'all';
    const rows = filter === 'stock' ? active().map(threadRow) : filter === 'all' ? items.map(threadRow) : [];
    return json(200, { filter, available: true, threads: rows, groups: rows.length ? [{ key: 'none', label: 'Other', threads: rows.length, needsYou: 0 }] : [], nextCursor: null });
   }
   const owner = items.find(i => p.startsWith(`/threads/${i.thread}`));
   if (owner) {
    const rest = p.slice(`/threads/${owner.thread}`.length), list = messages[owner.thread], last = list.at(-1)?.seq ?? 0;
    if (rest === '') return json(200, { thread: { id: owner.thread, kind: 'record', title: owner.name, revision: 1, lastSeq: last, lastChange: last, readPosition: last, unread: 0, starred: false, createdAt: at },
     card: { record: { kind: 'stock', id: owner.id }, title: owner.name, status: owner.currentCount === null ? 'not_counted' : 'counted', facts: threadRow(owner).facts, fold: fold(owner) }, tags: [], pin: null });
    if (rest === '/messages') return json(200, { thread: { id: owner.thread, revision: 1, lastSeq: last, lastChange: last }, messages: list.slice(-50), hasMore: false });
    if (rest === '/changes') { const after = Number(url.searchParams.get('after')); return json(200, { thread: { id: owner.thread, revision: 1, lastSeq: last, highWater: last }, changes: list.filter(m => m.changeSeq > after).map(message => ({ changeSeq: message.changeSeq, kind: 'message', message })), next: last, complete: true }); }
    if (rest === '/read') return json(200, { readPosition: last, unread: 0 });
    return json(503, {});
   }
   if (p === '/stock' && method === 'GET') { const all = url.searchParams.get('includeArchived') === '1'; return json(200, { items: (all ? items : active()).map(listed), locations: locations(), suppliers: [], timezone: zone }); }
   if (p === '/stock/stocktake' && method === 'POST') {
    expect(Object.keys(body).sort()).toEqual(['changeSetId', 'counts']);
    for (const c of body.counts) expect(Object.keys(c).sort()).toEqual(['count', 'expectedRevision', 'itemId']);
    const answer = () => json(201, { changeSetId: body.changeSetId, items: body.counts.map(c => listed(items.find(i => i.id === c.itemId))) }, { 'change-set-id': body.changeSetId });
    if (taken.has(body.changeSetId)) { expect(body).toEqual(taken.get(body.changeSetId)); return answer(); }
    const m = once('take');
    if (m === 'stale') { count(wheat, '6', maya, uuid(4000 + ++seq)); return json(409, { ok: false, code: 'stale_revision', error: 'Some items changed.', itemIds: [wheat.id] }); }
    const moved = body.counts.filter(c => items.find(i => i.id === c.itemId).revision !== c.expectedRevision).map(c => c.itemId);
    if (moved.length) return json(409, { ok: false, code: 'stale_revision', error: 'Some items changed.', itemIds: moved });
    for (const c of body.counts) count(items.find(i => i.id === c.itemId), c.count, user, body.changeSetId);
    taken.set(body.changeSetId, body);
    if (m === 'unknown') return json(503, {});
    return answer();
   }
   if (p === '/stock' && method === 'POST') {
    expect(Object.keys(body).sort()).toEqual(['changeSetId', 'location', 'name', 'reorderPoint', 'unitLabel']);
    const i = item(10 + ++made, body.name, body.location, body.unitLabel, null); i.reorderPoint = body.reorderPoint; items.push(i); messages[i.thread] = [];
    return json(201, { ...row(i), changeSetId: body.changeSetId }, { 'change-set-id': body.changeSetId });
   }
   const one = items.find(i => p === `/stock/${i.id}`);
   if (one && method === 'GET') return json(200, { item: listed(one), counts: one.history.slice(0, 3), locations: locations(), timezone: zone });
   if (one && method === 'PATCH') {
    expect(body.expectedRevision).toBe(one.revision);
    const changes = [];
    for (const k of ['name', 'location', 'unitLabel', 'reorderPoint', 'notes']) if (k in body && body[k] !== one[k]) { changes.push(change(one, { field: k, before: one[k], after: body[k] })); one[k] = body[k]; }
    if ('archived' in body) { const to = body.archived ? '2026-10-08T01:00:00.000Z' : null; changes.push(change(one, { field: 'archivedAt', before: one.archivedAt, after: to })); one.archivedAt = to; }
    one.revision++; line(one.thread, user, changes, body.changeSetId);
    return json(200, { ...row(one), changeSetId: body.changeSetId }, { 'change-set-id': body.changeSetId });
   }
   return json(503, {});
  });
  page.on('pageerror', e => errors.push(e.message));
  const id = n => page.getByTestId(n).filter({ visible: true });
  const go = p => page.goto(new URL(p, production).href);
  const name = n => `${width}-${scheme === 'dark' ? 'dark-' : ''}stock-${n}.png`;
  const shot = async n => { if (shots) { await page.evaluate(() => document.activeElement?.blur?.()); await page.screenshot({ path: path.join(shots, name(n)), fullPage: true }); } };
  const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const targets = async scope => { const small = await page.evaluate(sel => [...document.querySelectorAll(`${sel} input, ${sel} select, ${sel} [role="button"], ${sel} [role="link"]`)].filter(e => e.offsetParent && e.type !== 'checkbox').map(e => { const r = e.getBoundingClientRect(); return [e.getAttribute('aria-label') ?? e.getAttribute('data-testid'), Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 44 || w < 44), scope); expect(small).toEqual([]); };
  const takes = () => writes.filter(w => w.path === '/stock/stocktake');
  const field = i => id(`stocktake-count-${i.id}`);

  // The Stock filter's pinned row says how many items there are and opens Stocktake.
  await go('/'); await id('threads-filter-4').click();
  await expect(id('threads-pinned-stocktake')).toHaveText('Stocktake · 6 items'); await expect(id('threads-pinned-stocktake')).toHaveAttribute('role', 'link');
  await targets('[data-testid="threads-list"]'); await overflow(); await shot('filter');
  await id('threads-filter-0').click(); await expect(id('threads-pinned-stocktake')).toHaveCount(0);
  await id('threads-filter-4').click(); await id('threads-pinned-stocktake').click();
  await expect(page.getByRole('heading', { name: 'Stocktake', exact: true })).toBeVisible(); expect(new URL(page.url()).pathname).toBe('/stock/stocktake');

  // Board 12: the hint, items grouped by location, last counts in words, unit placeholders, decimal fields with labels.
  await expect(page.getByText('Type what you count. Items you skip are left as they are.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Cool room', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Packaging store', exact: true })).toBeVisible();
  await expect(id(`stocktake-last-${pale.id}`)).toHaveText('11 bags · counted Mon 28 Sep by Tom');
  await expect(id(`stocktake-last-${citra.id}`)).toHaveText('2.5 kg · counted Mon 21 Sep by Maya');
  await expect(id(`stocktake-last-${cans.id}`)).toHaveText('4,200 cans · counted Mon 28 Sep by Tom');
  await expect(id(`stocktake-last-${labels.id}`)).toHaveText('Not counted yet');
  await expect(field(citra)).toHaveAttribute('placeholder', 'kg'); await expect(field(citra)).toHaveAttribute('inputmode', 'decimal');
  await expect(field(pale)).toHaveAttribute('aria-label', 'Pale malt, bags'); await expect(field(cans)).toHaveAttribute('aria-label', '330 ml cans');
  await expect(id('stocktake-counted')).toHaveText('0 of 6 counted'); await expect(id('stocktake-save')).toHaveAttribute('aria-disabled', 'true');
  await field(pale).fill('12'); await field(wheat).fill('4');
  await expect(id('stocktake-counted')).toHaveText('2 of 6 counted'); await expect(id('stocktake-save')).not.toHaveAttribute('aria-disabled', 'true');
  await targets('[data-testid="stocktake"]'); await targets('[data-testid="stocktake-bar"]'); await overflow(); await shot('stocktake');
  // A bad count is said on its row and blocks Save.
  await field(citra).fill('2,5'); await expect(id(`stocktake-invalid-${citra.id}`)).toBeVisible(); await expect(id('stocktake-save')).toHaveAttribute('aria-disabled', 'true');
  await field(citra).fill('');
  // Leaving and coming back keeps the typed counts (session storage, this person and organisation).
  await go('/'); await go('/stock/stocktake'); await expect(field(pale)).toHaveValue('12'); await expect(field(wheat)).toHaveValue('4');

  // A stale item: nothing is saved, the row is marked with its new count and cleared, the rest stay typed.
  mode.take = 'stale'; await id('stocktake-save').click();
  await expect(id('stocktake-status')).toContainText('Someone changed the marked items since you opened Stocktake, so nothing was saved.');
  await expect(id(`stocktake-stale-${wheat.id}`)).toBeVisible(); await expect(id(`stocktake-last-${wheat.id}`)).toContainText('6 bags · counted');
  await expect(id(`stocktake-last-${wheat.id}`)).toContainText('by Maya');
  await expect(field(wheat)).toHaveValue(''); await expect(field(pale)).toHaveValue('12'); await overflow(); await shot('stale');
  expect(takes()).toHaveLength(1);

  // An uncertain save: the form locks; only an explicit "Save again with the same ID" sends it again, with the same body.
  await field(wheat).fill('5'); await expect(id(`stocktake-stale-${wheat.id}`)).toHaveCount(0);
  mode.take = 'unknown'; await id('stocktake-save').click();
  await expect(id('stocktake-retry')).toHaveText('Save again with the same ID'); await expect(field(pale)).toHaveAttribute('aria-disabled', 'true');
  await expect(id('stocktake-save')).toHaveAttribute('aria-disabled', 'true'); await shot('uncertain');
  await page.waitForTimeout(400); expect(takes()).toHaveLength(2);
  // It survives leaving the screen too.
  await go('/stock/stocktake'); await expect(id('stocktake-retry')).toBeVisible(); expect(takes()).toHaveLength(2);
  await id('stocktake-retry').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(id('threads-stocktake-saved')).toHaveText('Stocktake saved: 2 items counted. Each count is in its item’s thread.');
  const sent = takes(); expect(sent).toHaveLength(3); expect(sent[2].body).toEqual(sent[1].body); expect(sent[1].body.changeSetId).not.toBe(sent[0].body.changeSetId);
  expect(sent[1].body.counts).toEqual([{ itemId: pale.id, expectedRevision: 2, count: '12' }, { itemId: wheat.id, expectedRevision: 3, count: '5' }]);
  await overflow(); await shot('saved');
  // The change lines are in each counted item's thread; a skipped item has none.
  await go(`/threads/${pale.thread}`); await expect(page.getByText('Sam changed the count from 11 bags to 12 bags', { exact: false })).toBeVisible();
  await go(`/threads/${wheat.thread}`); await expect(page.getByText('changed the count from 6 bags to 5 bags', { exact: false })).toBeVisible();
  expect(messages[citra.thread]).toHaveLength(0);
  // Saved counts are gone from the draft.
  await go('/stock/stocktake'); await expect(field(pale)).toHaveValue(''); await expect(id(`stocktake-last-${pale.id}`)).toContainText('12 bags · counted');

  // Add an item in place, with an existing location chosen; the row appears in its location.
  await id('stocktake-add-open').click(); await expect(id('stocktake-add')).toBeVisible();
  await id('stocktake-add-name').fill('Hop pellets bags'); await id('stocktake-add-location-choice').filter({ hasText: 'Packaging store' }).click();
  await expect(id('stocktake-add-location')).toHaveValue('Packaging store');
  await id('stocktake-add-unit').fill('boxes'); await id('stocktake-add-reorder').fill('3');
  await targets('[data-testid="stocktake-add"]'); await overflow(); await shot('add');
  await id('stocktake-add-save').click();
  await expect(id('stocktake-added')).toHaveText('Added Hop pellets bags to Packaging store.');
  const added = items.at(-1); await expect(id(`stocktake-row-${added.id}`)).toBeVisible();
  await expect(id(`stocktake-group-Packaging store`).getByTestId(`stocktake-row-${added.id}`)).toBeVisible();
  expect(writes.filter(w => w.path === '/stock' && w.method === 'POST').map(w => w.body)).toEqual([{ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Hop pellets bags', location: 'Packaging store', unitLabel: 'boxes', reorderPoint: '3' }]);
  await expect(id('stocktake-counted')).toHaveText('0 of 7 counted');
  // Cancel with typed counts asks first; keeping counting keeps them.
  await field(wrap).fill('2'); await id('stocktake-cancel').click(); await expect(id('stocktake-cancel-confirm')).toHaveText('Discard 1 typed count? Nothing has been saved.');
  await id('stocktake-cancel-keep').click(); await expect(field(wrap)).toHaveValue('2');
  await id('stocktake-cancel').click(); await id('stocktake-cancel-discard').click(); await expect.poll(() => new URL(page.url()).pathname).toBe('/');

  // The stock card: details saved together, the last three counts, the Stocktake link, archive with its confirm step.
  await go(`/threads/${pale.thread}`); await id('thread-card-fold').click();
  await expect(id('stock-name')).toHaveValue('Pale malt'); await expect(id('stock-unit')).toHaveAttribute('aria-disabled', 'true');
  await expect(id('stock-counts')).toContainText('12 bags'); await expect(id('stock-counts')).toContainText('11 bags');
  await expect(id('stock-details-save')).toHaveAttribute('aria-disabled', 'true');
  await id('stock-notes').fill('Keep off the floor'); await id('stock-reorder').fill('5');
  await targets('[data-testid="stock-editor"]'); await overflow(); await shot('card');
  await id('stock-details-save').click(); await expect(id('stock-details-status')).toContainText('Saved');
  expect(writes.filter(w => w.path === `/stock/${pale.id}`).at(-1).body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 3, reorderPoint: '5', notes: 'Keep off the floor' });
  await id('stock-archive').click(); await expect(id('stock-archive-confirm')).toContainText('Archive Pale malt? It leaves Stocktake and the Stock filter.');
  await targets('[data-testid="stock-archive-confirm"]'); await shot('archive-confirm');
  await id('stock-archive-no').click(); await expect(id('stock-archive-confirm')).toHaveCount(0);
  expect(writes.filter(w => w.path === `/stock/${pale.id}`)).toHaveLength(1); // keeping it writes nothing
  await id('stock-archive').click(); await id('stock-archive-yes').click();
  await expect(id('stock-archived')).toBeVisible(); await expect(id('stock-restore')).toBeVisible();
  expect(writes.filter(w => w.path === `/stock/${pale.id}`).at(-1).body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 4, archived: true });
  // The card's Stocktake link opens the screen, without the archived item; Show archived lists it with Restore.
  await id('stock-stocktake-link').click(); await expect(page.getByRole('heading', { name: 'Stocktake', exact: true })).toBeVisible();
  await expect(id(`stocktake-row-${pale.id}`)).toHaveCount(0); await expect(id('stocktake-counted')).toHaveText('0 of 6 counted');
  await id('stocktake-show-archived').click(); await expect(id(`stocktake-archived-${pale.id}`)).toContainText('Pale malt');
  await id(`stocktake-restore-${pale.id}`).click(); await id(`stocktake-restore-yes-${pale.id}`).click();
  await expect(id('stocktake-archived-empty')).toHaveText('No archived items.'); await expect(id(`stocktake-row-${pale.id}`)).toBeVisible();
  expect(writes.filter(w => w.path === `/stock/${pale.id}`).at(-1).body).toMatchObject({ expectedRevision: 5, archived: false });
  for (const w of writes.filter(w => w.path.startsWith("/stock"))) expect(w.body.changeSetId).toMatch(/^[0-9a-f-]{36}$/);
  expect(errors).toEqual([]); expect(outside).toEqual([]);
  console.log(`PASS ${width}px${scheme === 'dark' ? ' dark' : ''}: the Stock filter's Stocktake row; Stocktake by location (type two, skip the rest, one save, change lines), kept on leaving, a stale item, an uncertain save and same-ID retry; add an item; the stock card's details, last counts and archive with its confirm; Show archived and Restore`);
 } finally { await context.close(); }
};
