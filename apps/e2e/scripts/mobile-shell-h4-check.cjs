/** H4 (docs/plans/tags-series-search-2026-10.md §3, §4): search in the list header (results with the match marked, no
 *  match, clear back to the list, under 2 characters keeps the list); Tags from the filter row's menu (the list with
 *  owners, dates and counts, Show archived, Add a tag with an owner and dates) and a tag's details (rename, owner and
 *  dates saved as one change, an uncertain save retried with the same ID and body, archive and restore after a confirm);
 *  a tag heading's menu opening its details; "Repeat this task" on a task card (the rule form, one POST with fromTask and
 *  the task's title, body and tags, then "Repeats …" and "Part of … · Edit the series"); the series screen (edit, pause,
 *  resume). Production export with synthetic, contract-shaped API answers (shapes from apps/api/src/{threads,tags,
 *  commitments}; apps/api/src/threads/search.test.ts feeds the real ones through the same parsers). Every write is
 *  recorded: one request per press, the client's change set id, the exact body on an explicit retry. Not hosted, native
 *  or assistive technology. */
const { expect } = require('@playwright/test'); const path = require('node:path');
module.exports = async ({ browser, production, shots, width, scheme = 'light' }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, colorScheme: scheme });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const user = uuid(1), org = uuid(2), maya = uuid(41), tom = uuid(42);
  const taskThread = uuid(11), canningThread = uuid(12), lunchThread = uuid(13), springThread = uuid(14), taskId = uuid(43), seriesId = uuid(90);
  const at = '2026-10-01T06:40:00.000Z', zone = 'Australia/Sydney';
  const people = { [user]: 'Sam Skipper', [maya]: 'Maya Chen', [tom]: 'Tom Reilly' };
  const writes = [], errors = [], outside = [], lists = [];
  let mode = {}, seq = 0;
  const once = key => { const m = mode[key]; delete mode[key]; return m; };
  const tagRow = (id, name, x = {}) => ({ id, name, ownerId: null, startsOn: null, endsOn: null, archivedAt: null, revision: 1, createdBy: user, createdAt: at, updatedAt: at, ...x });
  const compliance = uuid(60), production_ = uuid(61), spring = uuid(62);
  const tags = [tagRow(compliance, 'Compliance', { ownerId: maya, startsOn: '2026-07-01', endsOn: '2027-06-30', revision: 2 }), tagRow(production_, 'Production'), tagRow(spring, 'Spring release', { archivedAt: '2026-09-20T00:00:00.000Z', revision: 3 })];
  const taskRow = (x = {}) => ({ id: taskId, parentId: null, title: 'Excise return', body: 'File by the 21st.', status: 'open', ownerId: maya, ownerName: 'Maya Chen', due: '2026-10-21', sourceKind: 'person', sourceId: null, seriesId: null, periodStart: null, periodEnd: null,
   evidenceRequired: false, completedBy: null, completedAt: null, revision: 4, createdAt: at, updatedAt: at, evidenceCount: 0, evidence: [], ...x });
  let task = taskRow(), series = null;
  const said = (thread, n, author, body) => ({ id: uuid(1000 + ++seq), threadId: thread, kind: 'message', seq: n, changeSeq: n, authorId: author, authorName: people[author], body, createdAt: at, editedAt: null, deletedAt: null, deletedBy: null, revision: 1 });
  const threads = {
   [taskThread]: { kind: 'record', title: () => task.title, tagIds: [compliance], messages: [said(taskThread, 1, maya, 'The portal opens on the 1st. I file it before the 21st.')] },
   [canningThread]: { kind: 'topic', title: () => 'Canning line next week', tagIds: [production_], messages: [said(canningThread, 1, tom, 'Book the canning line for Thursday, after the keg wash.')] },
   [lunchThread]: { kind: 'topic', title: () => 'Lunch order', tagIds: [], messages: [said(lunchThread, 1, maya, 'Pizza on Friday for the crew.')] },
   [springThread]: { kind: 'topic', title: () => 'Spring release wrap-up', tagIds: [spring], messages: [said(springThread, 1, tom, 'Sold through. Archiving the tag.')] }
  };
  const chips = ids => ids.map(i => tags.find(t => t.id === i)).filter(Boolean).map(t => ({ id: t.id, name: t.name }));
  const live = ids => chips(ids.filter(i => !tags.find(t => t.id === i).archivedAt));
  const row = id => { const t = threads[id], last = t.messages.at(-1); return { id, kind: t.kind, title: t.title(), record: t.kind === 'record' ? { kind: 'task', id: taskId } : null,
   facts: t.kind === 'record' ? [task.ownerName ?? 'No owner', task.due ?? 'No due date'] : [people[t.messages[0].authorId], ''], status: t.kind === 'record' ? task.status : null,
   lastMessageAt: at, lastMessage: last ? { authorName: last.authorName, excerpt: last.body.slice(0, 120) } : null, unread: 0, needsYou: false, starred: false, tags: live(t.tagIds) }; };
  const groups = ids => {
   const out = tags.filter(t => !t.archivedAt).map(t => ({ key: t.id, label: t.name, threads: ids.filter(i => threads[i].tagIds.includes(t.id)).length, needsYou: 0, owner: t.ownerId ? { id: t.ownerId, name: people[t.ownerId] } : null, startsOn: t.startsOn, endsOn: t.endsOn })).filter(g => g.threads);
   const none = ids.filter(i => live(threads[i].tagIds).length === 0).length;
   return [...out, ...(none ? [{ key: 'none', label: 'Other', threads: none, needsYou: 0, owner: null, startsOn: null, endsOn: null }] : [])].sort((a, b) => b.threads - a.threads || a.label.localeCompare(b.label));
  };
  /** The API's search as the contract says it, for these few threads: every word a prefix, title before message. */
  const search = q => {
   const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
   const hit = text => words.length && words.every(w => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).some(x => x.startsWith(w)));
   const mark = text => text.split(/(\s+)/).map(x => words.some(w => x.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').startsWith(w)) ? `«${x.replace(/[.,]$/, '')}»${x.match(/[.,]$/)?.[0] ?? ''}` : x).join('');
   return Object.keys(threads).flatMap(id => { const t = threads[id];
    if (hit(t.title())) return [{ ...row(id), match: { kind: 'title', excerpt: mark(t.title()), authorName: null } }];
    const m = t.messages.find(m => hit(m.body)); return m ? [{ ...row(id), match: { kind: 'message', excerpt: mark(m.body), authorName: m.authorName } }] : []; });
  };
  const fold = () => ({ body: task.body, status: task.status, ownerId: task.ownerId, ownerName: task.ownerName, due: task.due, evidenceRequired: task.evidenceRequired, seriesId: task.seriesId, open: null });
  const detail = id => { const t = threads[id], last = t.messages.at(-1)?.seq ?? 0; return { thread: { id, kind: t.kind, title: t.title(), revision: 1, lastSeq: last, lastChange: last, readPosition: last, unread: 0, starred: false, createdAt: at },
   card: t.kind === 'record' ? { record: { kind: 'task', id: taskId }, title: task.title, status: task.status, facts: [task.ownerName ?? '', task.due ?? ''], fold: fold() } : { record: null, title: t.title(), status: null, facts: [people[t.messages[0].authorId], ''], fold: { createdBy: t.messages[0].authorId, open: null } },
   tags: chips(t.tagIds), pin: null }; };
  const seriesRow = () => ({ ...series, nextDue: series.pausedAt ? null : '2026-10-21' });
  const counted = t => ({ ...t, threads: Object.values(threads).filter(x => x.tagIds.includes(t.id)).length });
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
   if (p === '/threads' && method === 'GET') {
    const filter = url.searchParams.get('filter') || 'all', q = url.searchParams.get('q');
    if (q !== null) { expect(url.searchParams.get('limit')).toBe('50'); expect(url.searchParams.has('after')).toBe(false); const rows = filter === 'all' ? search(q.trim()) : filter === 'tasks' ? search(q.trim()).filter(r => r.record) : []; return json(200, { filter, q, available: true, threads: rows }); }
    lists.push(filter);
    const ids = filter === 'all' ? Object.keys(threads) : filter === 'tasks' ? [taskThread] : [];
    return json(200, { filter, available: true, threads: ids.map(row), groups: groups(ids), nextCursor: null });
   }
   const thread = Object.keys(threads).find(id => p.startsWith(`/threads/${id}`));
   if (thread) {
    const t = threads[thread], rest = p.slice(`/threads/${thread}`.length), last = t.messages.at(-1)?.seq ?? 0;
    if (rest === '') return json(200, detail(thread));
    if (rest === '/messages') return json(200, { thread: { id: thread, revision: 1, lastSeq: last, lastChange: last }, messages: t.messages.slice(-50), hasMore: false });
    if (rest === '/changes') return json(200, { thread: { id: thread, revision: 1, lastSeq: last, highWater: last }, changes: [], next: last, complete: true });
    if (rest === '/read') return json(200, { readPosition: last, unread: 0 });
    return json(503, {});
   }
   if (p === '/tags' && method === 'GET') {
    const counts = url.searchParams.get('counts') === 'true';
    return json(200, { tags: tags.slice().sort((a, b) => a.name.localeCompare(b.name)).map(t => counts ? counted(t) : t), nextOffset: null });
   }
   if (p === '/tags' && method === 'POST') {
    expect(body.changeSetId).toMatch(/^[0-9a-f-]{36}$/);
    if (tags.some(t => t.name.toLowerCase() === body.name.toLowerCase())) return json(409, { ok: false, code: 'tag_name_exists', error: 'A tag with that name already exists.' });
    const { changeSetId, ...fields } = body; const t = tagRow(uuid(63 + seq++), fields.name, fields); tags.push(t); return json(201, { ...t, changeSetId }, { 'change-set-id': changeSetId });
   }
   const one = tags.find(t => p === `/tags/${t.id}`);
   if (one && method === 'GET') return json(200, counted(one));
   if (one && method === 'PATCH') {
    expect(body.expectedRevision).toBe(one.revision);
    const m = once('tag');
    const { changeSetId, expectedRevision: _, archived, ...fields } = body;
    Object.assign(one, fields, archived === undefined ? {} : { archivedAt: archived ? '2026-10-08T01:00:00.000Z' : null }, { revision: one.revision + 1, updatedAt: '2026-10-08T01:00:00.000Z' });
    if (m === 'unknown') return json(503, {});
    return json(200, { ...one, changeSetId }, { 'change-set-id': changeSetId });
   }
   if (p === `/tasks/${taskId}` && method === 'GET') return json(200, { task, parent: null, series: series ? { id: series.id, title: series.title } : null, checklist: { tasks: [], nextOffset: null }, evidenceNextOffset: null, tags: { items: chips(threads[taskThread].tagIds), nextOffset: null }, today: '2026-10-08', timezone: zone });
   if (p === '/series' && method === 'POST') {
    expect(Object.keys(body).sort()).toEqual(['anchor', 'body', 'changeSetId', 'dueOffsetDays', 'everyMonths', 'evidenceRequired', 'fromTask', 'ownerId', 'recurrence', 'tagIds', 'title']);
    expect(body.fromTask).toEqual({ id: taskId, expectedRevision: task.revision });
    const { changeSetId, fromTask: _f, ...fields } = body;
    series = { id: seriesId, ...fields, pausedAt: null, revision: 1, createdAt: at, updatedAt: at };
    task = { ...task, seriesId, periodStart: '2026-10-01', periodEnd: '2026-10-31', revision: task.revision + 1 };
    return json(201, { ...seriesRow(), changeSetId }, { 'change-set-id': changeSetId });
   }
   if (series && p === `/series/${seriesId}` && method === 'GET') return json(200, seriesRow());
   if (series && p === `/series/${seriesId}` && method === 'PATCH') {
    expect(body.expectedRevision).toBe(series.revision);
    const { changeSetId, expectedRevision: _, paused, ...fields } = body;
    Object.assign(series, fields, paused === undefined ? {} : { pausedAt: paused ? '2026-10-08T01:00:00.000Z' : null }, { revision: series.revision + 1 });
    return json(200, { ...seriesRow(), changeSetId }, { 'change-set-id': changeSetId });
   }
   return json(503, {});
  });
  page.on('pageerror', e => errors.push(e.message));
  const id = n => page.getByTestId(n).filter({ visible: true });
  const go = p => page.goto(new URL(p, production).href);
  const name = n => `${width}-${scheme === 'dark' ? 'dark-' : ''}h4-${n}.png`;
  const shot = async n => { if (shots) { await page.evaluate(() => document.activeElement?.blur?.()); await page.screenshot({ path: path.join(shots, name(n)), fullPage: true }); } };
  const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const targets = async scope => { const small = await page.evaluate(sel => [...document.querySelectorAll(`${sel} input, ${sel} select, ${sel} [role="button"], ${sel} [role="link"], ${sel} [role="menuitem"], ${sel} [role="radio"]`)].filter(e => e.offsetParent && e.type !== 'checkbox').map(e => { const r = e.getBoundingClientRect(); return [e.getAttribute('aria-label') ?? e.getAttribute('data-testid'), Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 44 || w < 44), scope); expect(small).toEqual([]); };
  const posted = p => writes.filter(w => w.path === p);

  // Search: the header's magnifier opens the field; 2 characters search; results replace the groups with the match marked.
  await go('/');
  await expect(id(`thread-group-${compliance}`)).toBeVisible(); await expect(id('thread-group-none')).toBeVisible();
  await expect(id(`thread-group-${spring}`)).toHaveCount(0); // an archived tag has no heading
  await id('threads-search-toggle').click(); await expect(id('threads-search')).toBeFocused();
  await id('threads-search').fill('c'); await page.waitForTimeout(450);
  await expect(id(`thread-group-${compliance}`)).toBeVisible(); // one character: the list stays
  await id('threads-search').fill('cann');
  await expect(id('threads-search-count')).toHaveText('1 result');
  await expect(id(`thread-group-${compliance}`)).toHaveCount(0);
  const bold = async (testId, word) => expect(await id(testId).locator('*').evaluateAll((els, w) => els.filter(e => e.textContent === w).map(e => getComputedStyle(e).fontWeight), word)).toEqual(['700']);
  await expect(id(`thread-row-${canningThread}`)).toContainText('Canning line next week'); // a title match: the title's word is marked
  await bold(`thread-row-${canningThread}`, 'Canning');
  await id('threads-search').fill('thursday wash');
  await expect(id('threads-search-count')).toHaveText('1 result');
  await expect(id(`thread-match-${canningThread}`)).toHaveText('Tom: Book the canning line for Thursday, after the keg wash.'); // a message match: its excerpt, marked
  await bold(`thread-match-${canningThread}`, 'Thursday'); await bold(`thread-match-${canningThread}`, 'wash');
  await targets('[data-testid="threads-list"]'); await overflow(); await shot('search');
  await id('threads-search').fill('excise');
  await expect(id('threads-search-count')).toHaveText('1 result'); await expect(id(`thread-row-${taskThread}`)).toBeVisible(); // a title match marks the title
  await id('threads-search').fill('zebra'); await expect(id('threads-search-count')).toHaveText('No threads match'); await shot('search-none');
  const listed = lists.length;
  await id('threads-search-clear').click(); await expect(id('threads-search')).toHaveCount(0);
  await expect(id(`thread-group-${compliance}`)).toBeVisible(); expect(lists.length).toBe(listed); // the list comes back as it was
  await id('threads-search-toggle').click(); await id('threads-search').fill('pizza'); await expect(id('threads-search-count')).toHaveText('1 result');
  await id('threads-filter-2').click(); await expect(id('threads-search-count')).toHaveText('No threads match'); // the filter applies to the search
  await id('threads-filter-0').click(); await expect(id('threads-search-count')).toHaveText('1 result');
  await id('threads-search-toggle').click(); await expect(id('threads-search')).toHaveCount(0);

  // Tags from the filter row's menu.
  await id('threads-more-actions').click(); await id('threads-manage-tags').click();
  await expect(page.getByRole('heading', { name: 'Tags', exact: true })).toBeVisible();
  await expect(id(`tag-row-${compliance}`)).toContainText('Maya Chen · 1 Jul 2026 – 30 Jun 2027 · 1 thread');
  await expect(id(`tag-row-${production_}`)).toContainText('1 thread'); await expect(id(`tag-row-${spring}`)).toHaveCount(0);
  await targets('[data-testid="tags-manage"]'); await overflow(); await shot('tags');
  await id('tags-show-archived').click(); await expect(id(`tag-row-${spring}`)).toContainText('1 thread · Archived'); await id('tags-show-archived').click();
  // Add a tag with an owner and dates: one POST with the client's change set id.
  await id('tags-add-open').click(); await id('tags-add-name').fill('Summer lager launch');
  await page.getByTestId('tags-add-owner').selectOption(tom); await page.getByTestId('tags-add-starts').fill('2026-11-01'); await page.getByTestId('tags-add-ends').fill('2026-10-01');
  await expect(id('tags-add-problem')).toHaveText('The end date cannot be before the start date.'); await expect(id('tags-add-save')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('tags-add-ends').fill('2027-01-31'); await shot('tags-add');
  await id('tags-add-save').click(); await expect(id('tags-status')).toContainText('Saved');
  expect(posted('/tags')).toHaveLength(1);
  const added = posted('/tags')[0].body; expect(added).toEqual({ changeSetId: added.changeSetId, name: 'Summer lager launch', ownerId: tom, startsOn: '2026-11-01', endsOn: '2027-01-31' });
  const newTag = tags.find(t => t.name === 'Summer lager launch');
  await expect(id(`tag-row-${newTag.id}`)).toContainText('Tom Reilly · 1 Nov 2026 – 31 Jan 2027 · 0 threads');
  // Its details: rename and change the dates as one change; an uncertain answer keeps the ID and the body for Save again.
  await id(`tag-row-${newTag.id}`).click();
  await expect(page.getByRole('heading', { name: 'Summer lager launch', exact: true })).toBeVisible();
  await id('tag-name').fill('Summer lager'); await page.getByTestId('tag-ends').fill('2027-02-28'); await page.getByTestId('tag-owner').selectOption(maya);
  mode.tag = 'unknown'; await id('tag-save').click();
  await expect(id('tag-retry')).toBeVisible(); await expect(id('tag-name')).toBeDisabled();
  const patches = () => posted(`/tags/${newTag.id}`);
  expect(patches()).toHaveLength(1);
  // Our synthetic API applied it; the retry is the same change set and body, answered as the first result would be.
  newTag.revision -= 1;
  await id('tag-retry').click(); await expect(id('tag-status')).toContainText('Saved');
  expect(patches()).toHaveLength(2); expect(patches()[1].body).toEqual(patches()[0].body);
  expect(patches()[0].body).toEqual({ changeSetId: patches()[0].body.changeSetId, expectedRevision: 1, name: 'Summer lager', ownerId: maya, endsOn: '2027-02-28' });
  await expect(page.getByRole('heading', { name: 'Summer lager', exact: true })).toBeVisible();
  await expect(id('tag-summary')).toHaveText('Maya Chen · 1 Nov 2026 – 28 Feb 2027 · 0 threads');
  await targets('[data-testid="tag-detail"]'); await overflow(); await shot('tag');
  // Archive after a confirm step; restore after another.
  await id('tag-archive').click(); await expect(id('tag-confirm')).toContainText('Archive Summer lager?'); await shot('tag-archive');
  await id('tag-confirm-yes').click(); await expect(id('tag-archived')).toBeVisible();
  expect(patches().at(-1).body).toEqual({ changeSetId: patches().at(-1).body.changeSetId, expectedRevision: 2, archived: true });
  await id('tag-restore').click(); await id('tag-confirm-yes').click(); await expect(id('tag-archived')).toHaveCount(0); await expect(id('tag-archive')).toBeVisible();

  // A tag heading's menu opens its details.
  await go('/'); await id(`thread-group-menu-${compliance}`).click(); await expect(id(`thread-group-actions-${compliance}`)).toBeVisible();
  await targets(`[data-testid="threads-list"]`); await shot('group-menu');
  await id(`thread-group-details-${compliance}`).click();
  await expect(page.getByRole('heading', { name: 'Compliance', exact: true })).toBeVisible(); expect(new URL(page.url()).pathname).toBe(`/tags/${compliance}`);

  // Repeat this task: the form opens from the task card, one POST makes the series from the task.
  await go(`/threads/${taskThread}`); await id('thread-card-fold').click();
  await expect(id('task-series')).toHaveCount(0);
  await id('task-repeat-open').click();
  await expect(page.getByTestId('task-repeat-recurrence')).toHaveValue('monthly'); await expect(page.getByTestId('task-repeat-anchor')).toHaveValue('2026-10-01');
  await expect(id('task-repeat-due-days')).toHaveValue('10'); await expect(id('task-repeat-due-words')).toHaveText('Each one is due 10 days before the period ends.');
  await expect(id('task-repeat-period')).toHaveText('This task becomes the occurrence for 1 Oct 2026 to 31 Oct 2026. It keeps this task’s tags: Compliance.');
  await page.getByTestId('task-repeat-recurrence').selectOption('custom'); await id('task-repeat-every').fill('0'); await expect(id('task-repeat-problem')).toHaveText('Repeat every 1 to 120 months.');
  await page.getByTestId('task-repeat-recurrence').selectOption('monthly');
  await page.getByTestId('task-repeat-evidence').check();
  await targets('[data-testid="task-repeat"]'); await overflow(); await shot('repeat');
  await id('task-repeat-save').click();
  await expect(id('task-repeats')).toHaveText('Repeats monthly from 1 Oct 2026, due 10 days before the period ends.');
  await expect(id('task-series')).toContainText('Part of Excise return'); await expect(id('task-repeat-open')).toHaveCount(0);
  const made = posted('/series'); expect(made).toHaveLength(1);
  expect(made[0].body).toEqual({ changeSetId: made[0].body.changeSetId, title: 'Excise return', body: 'File by the 21st.', tagIds: [compliance], ownerId: maya, evidenceRequired: true,
   recurrence: 'monthly', everyMonths: null, anchor: '2026-10-01', dueOffsetDays: -10, fromTask: { id: taskId, expectedRevision: 4 } });
  await shot('repeats');
  // Edit the series: a change of rule as one PATCH, then Pause and Resume.
  await id('task-series-edit').click(); await expect(page.getByRole('heading', { name: 'Excise return', exact: true })).toBeVisible();
  await expect(id('series-summary')).toHaveText('Repeats monthly from 1 Oct 2026, due 10 days before the period ends. Next due 21 Oct 2026.');
  await page.getByTestId('series-recurrence').selectOption('quarterly'); await page.getByTestId('series-due-when-after').click(); await id('series-due-days').fill('21');
  await expect(id('series-due-words')).toHaveText('Each one is due 21 days after the period ends.');
  await expect(id('series-pause')).toHaveAttribute('aria-disabled', 'true');
  await targets('[data-testid="series-detail"]'); await overflow(); await shot('series');
  await id('series-save').click(); await expect(id('series-status')).toContainText('Saved');
  const edits = () => posted(`/series/${seriesId}`);
  expect(edits()[0].body).toEqual({ changeSetId: edits()[0].body.changeSetId, expectedRevision: 1, recurrence: 'quarterly', everyMonths: null, dueOffsetDays: 21 });
  await id('series-pause').click(); await expect(id('series-paused')).toBeVisible();
  expect(edits()[1].body).toEqual({ changeSetId: edits()[1].body.changeSetId, expectedRevision: 2, paused: true });
  await expect(id('series-summary')).toHaveText('Paused. It repeats quarterly when resumed.'); await shot('series-paused');
  await id('series-resume').click(); await expect(id('series-paused')).toHaveCount(0);
  expect(edits()).toHaveLength(3); expect(new Set(writes.map(w => w.body?.changeSetId)).size).toBe(writes.length - 1); // one id per write; only the retry repeats one

  expect(errors).toEqual([]); expect(outside).toEqual([]);
  console.log(`PASS ${width}px${scheme === 'dark' ? ' dark' : ''}: search (results marked, no match, clear, filter, under 2 characters), Tags (counts, archived, add with owner and dates), tag details (one change, uncertain same-ID retry, archive and restore with confirm), heading menu, repeat a task (form, fromTask POST, Repeats and Part of), series (edit, pause, resume)`);
 } finally { await context.close(); }
};
