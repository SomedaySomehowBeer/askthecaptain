/** R3 V-D: change lines in a thread and editing a task, a booking and a stock count from its card, on the production
 *  export with synthetic, contract-shaped API answers (shapes from apps/api/src/{threads,commitments,equipment,stock};
 *  apps/api/src/threads/list.test.ts feeds the real ones through the same parsers). Every write is recorded: one request
 *  per save, the client's change set id, the exact body on an explicit retry. Not hosted, not native, not assistive
 *  technology. */
const { expect } = require('@playwright/test'); const path = require('node:path');
module.exports = async ({ browser, production, base, shots, width, scheme = 'light' }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, colorScheme: scheme });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const user = uuid(1), org = uuid(2), maya = uuid(41), tom = uuid(42), jess = uuid(51);
  const taskThread = uuid(11), bookingThread = uuid(12), stockThread = uuid(13);
  const taskId = uuid(43), stepA = uuid(44), stepB = uuid(49), bookingId = uuid(45), tank = uuid(46), itemId = uuid(47), production_ = uuid(48), lager = uuid(52), holder = uuid(53);
  const at = '2026-10-01T06:40:00.000Z', zone = 'Australia/Sydney';
  const writes = [], errors = [], outside = [], reads = [];
  let mode = {}; // per-path one-shot answers: { task: 'stale' | 'unknown', booking: 'conflict', ... }
  let seqs = 0;
  const people = { [user]: 'Sam Skipper', [maya]: 'Maya Chen', [tom]: 'Tom Reilly', [jess]: 'Jess Park' };
  const said = (thread, n, author, body, createdAt) => ({ id: uuid(1000 + ++seqs), threadId: thread, kind: 'message', seq: n, changeSeq: n, authorId: author, authorName: people[author], body, createdAt, editedAt: null, deletedAt: null, deletedBy: null, revision: 1 });
  const line = (thread, n, actor, changes, createdAt, changeSetId = uuid(2000 + ++seqs)) => ({ id: uuid(1000 + ++seqs), threadId: thread, kind: 'change', seq: n, changeSeq: n, authorId: actor, authorName: people[actor], body: null, createdAt, editedAt: null, deletedAt: null, deletedBy: null, revision: 1,
   changeSetId, change: { actorKind: 'person', actorId: actor, actorName: people[actor], causeKind: 'request', createdAt, changes, truncated: false } });
  const change = (recordKind, recordId, c) => ({ id: uuid(3000 + ++seqs), recordKind, recordId, operation: 'update', field: null, itemKind: null, itemId: null, before: null, after: null, ...c });
  const taskRow = (x = {}) => ({ id: taskId, parentId: null, title: 'Package summer lager', body: 'Use the new labels.', status: 'in_progress', ownerId: tom, ownerName: 'Tom Reilly', due: '2026-10-08', sourceKind: 'person', sourceId: maya, seriesId: null, periodStart: null, periodEnd: null,
   evidenceRequired: false, completedBy: null, completedAt: null, revision: 4, createdAt: at, updatedAt: at, evidenceCount: 0, evidence: [], ...x });
  let task = taskRow(), steps = [taskRow({ id: stepA, parentId: taskId, title: 'Book the canning line', status: 'open', ownerId: null, ownerName: null, due: null, revision: 1, body: '' }), taskRow({ id: stepB, parentId: taskId, title: 'Order pallet wrap', status: 'open', ownerId: null, ownerName: null, due: null, revision: 1, body: '' })];
  let booking = { id: bookingId, equipmentId: tank, title: 'Summer lager canning run', kind: 'booking', status: 'confirmed', startsAt: '2026-10-07T21:00:00.000Z', endsAt: '2026-10-08T01:00:00.000Z', setupMinutes: 30, cleanupMinutes: 30, occupiedStartsAt: '2026-10-07T20:30:00.000Z', occupiedEndsAt: '2026-10-08T01:30:00.000Z', taskId: null, ownerId: null, createdBy: maya, revision: 2, createdAt: at, updatedAt: at, tagIds: [lager] };
  let stock = { location: 'Cold store', unitLabel: 'kg', currentCount: '4.5', countedAt: '2026-10-01T04:10:00.000Z', reorderPoint: '2', notes: '', archivedAt: null, open: null };
  let other = null; // a booking that holds the slot after an overlap refusal
  const threads = {
   [taskThread]: { title: () => task.title, readPosition: 3, messages: [said(taskThread, 1, tom, 'Labels are delayed. The printer says Wednesday now, not Monday.', '2026-10-01T03:58:00.000Z'),
    line(taskThread, 2, maya, [change('task', taskId, { field: 'due', before: '2026-10-06', after: '2026-10-08' }), change('task', taskId, { operation: 'attach', itemKind: 'tag', itemId: production_, after: { threadId: taskThread, tagId: production_ } })], '2026-10-01T06:40:00.000Z'),
    said(taskThread, 3, maya, 'Moved it to Thursday so the labels are here first.', '2026-10-01T06:41:00.000Z'),
    line(taskThread, 4, tom, [change('task', taskId, { field: 'ownerId', before: maya, after: tom })], '2026-10-01T23:12:00.000Z'),
    said(taskThread, 5, tom, 'I’ll take this one from here. Maya has the launch to run.', '2026-10-01T23:13:00.000Z')],
    card: () => ({ record: { kind: 'task', id: taskId }, title: task.title, status: task.status, facts: [task.ownerName ?? '', task.due ?? ''], fold: { body: task.body, status: task.status, ownerId: task.ownerId, ownerName: task.ownerName, due: task.due, evidenceRequired: false, seriesId: null, open: null } }),
    tags: [{ id: production_, name: 'Production' }, { id: lager, name: 'Summer lager' }] },
   [bookingThread]: { title: () => booking.title, readPosition: 1, messages: [said(bookingThread, 1, tom, 'Thursday morning works for the crew.', '2026-10-01T04:14:00.000Z')],
    card: () => ({ record: { kind: 'booking', id: bookingId }, title: booking.title, status: booking.status, facts: ['Canning line', booking.startsAt.replace('.000', '')], fold: { equipmentId: tank, equipmentName: 'Canning line', kind: booking.kind, status: booking.status, startsAt: booking.startsAt, endsAt: booking.endsAt, setupMinutes: booking.setupMinutes, cleanupMinutes: booking.cleanupMinutes, taskId: null, ownerId: null, ownerName: null, open: { kind: 'equipment', equipmentId: tank } } }),
    tags: [{ id: lager, name: 'Summer lager' }] },
   [stockThread]: { title: () => 'Cascade hops', readPosition: 1, messages: [said(stockThread, 1, tom, 'Counted the back shelf too.', '2026-10-01T04:14:00.000Z')],
    card: () => ({ record: { kind: 'stock', id: itemId }, title: 'Cascade hops', status: 'counted', facts: [`${stock.currentCount} kg`, stock.countedAt.replace('.000', '')], fold: stock }), tags: [] }
  };
  const detail = id => { const t = threads[id], last = t.messages.at(-1)?.seq ?? 0; return { thread: { id, kind: 'record', title: t.title(), revision: 1, lastSeq: last, lastChange: last, readPosition: t.readPosition, unread: Math.min(51, t.messages.filter(m => m.seq > t.readPosition && m.authorId !== user).length), starred: false, createdAt: at }, card: t.card(), tags: t.tags, pin: null }; };
  const append = (thread, changes, changeSetId) => { const t = threads[thread]; t.messages.push(line(thread, t.messages.length + 1, user, changes, new Date().toISOString().replace(/\.\d+Z$/, '.000Z'), changeSetId)); };
  await context.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (![production.origin, base?.origin].includes(url.origin)) { outside.push(url.origin); return route.abort(); }
   const json = (status, value, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(value) });
   if (!url.pathname.startsWith('/v1/')) { const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1'; return route.fulfill({ response: await route.fetch({ url: upstream.href, maxRedirects: 0 }) }); }
   expect(req.headers()['x-captain-client']).toBe('web'); expect(req.headers().authorization).toBeUndefined();
   const p = url.pathname.replace(`/v1/organisations/${org}`, ''), method = req.method(), body = req.postData() ? req.postDataJSON() : undefined;
   if (method !== 'GET') writes.push({ method, path: p, body }); else reads.push(p + url.search);
   if (url.pathname === '/v1/me') return json(200, { user: { id: user, name: 'Sam Skipper', email: 'sam@example.test' }, memberships: [{ organisationId: org, organisationName: 'Harbour Brewing', role: 'member', status: 'active' }], passkeyVerified: true });
   if (url.pathname === '/v1/me/passkeys') return json(200, { available: false, passkeys: [] });
   if (p === '') return json(200, { id: org, name: 'Harbour Brewing', timezone: zone, locale: 'en-AU', createdAt: at, role: 'member' });
   if (p === '/members') return json(200, { members: [user, maya, tom, jess].map(userId => ({ userId, name: people[userId], email: `${userId.slice(-2)}@example.test`, role: 'member', status: 'active', since: at })) });
   if (p === '/tags') return json(200, { tags: [], nextOffset: null });
   const thread = Object.keys(threads).find(id => p.startsWith(`/threads/${id}`));
   if (thread) {
    const t = threads[thread], rest = p.slice(`/threads/${thread}`.length);
    if (rest === '') return json(200, detail(thread));
    if (rest === '/messages') { const last = t.messages.at(-1)?.seq ?? 0; return json(200, { thread: { id: thread, revision: 1, lastSeq: last, lastChange: last }, messages: t.messages.slice(-50), hasMore: false }); }
    if (rest === '/changes') { const after = Number(url.searchParams.get('after')), last = t.messages.at(-1)?.seq ?? 0; const changes = t.messages.filter(m => m.changeSeq > after).map(message => ({ changeSeq: message.changeSeq, kind: 'message', message })); return json(200, { thread: { id: thread, revision: 1, lastSeq: last, highWater: last }, changes, next: last, complete: true }); }
    if (rest === '/read') { t.readPosition = Math.max(t.readPosition, body.seq); return json(200, { readPosition: t.readPosition, unread: 0 }); }
    return json(503, {});
   }
   const once = key => { const m = mode[key]; delete mode[key]; return m; };
   if (p === `/tasks/${taskId}` && method === 'GET') return json(200, { task, parent: null, series: null, checklist: { tasks: steps, nextOffset: null }, evidenceNextOffset: null, tags: { items: [], nextOffset: null }, today: '2026-10-02', timezone: zone });
   if (p === `/tasks/${taskId}` && method === 'PATCH') {
    const m = once('task');
    if (m === 'stale') { task = { ...task, title: 'Package the summer lager', revision: task.revision + 1 }; append(taskThread, [change('task', taskId, { field: 'title', before: 'Package summer lager', after: 'Package the summer lager' })]); threads[taskThread].messages.at(-1).authorId = maya; threads[taskThread].messages.at(-1).authorName = 'Maya Chen'; threads[taskThread].messages.at(-1).change.actorId = maya; threads[taskThread].messages.at(-1).change.actorName = 'Maya Chen'; return json(409, { ok: false, code: 'stale_revision', error: 'This changed since you opened it.' }); }
    if (m === 'unknown') return json(503, {});
    expect(body.expectedRevision).toBe(task.revision);
    const changes = [];
    for (const [k, f] of [['title', 'title'], ['status', 'status'], ['ownerId', 'ownerId'], ['due', 'due']]) if (k in body && body[k] !== task[k]) changes.push(change('task', taskId, { field: f, before: task[k], after: body[k] }));
    // A retry with the same change set answers with the record as it is now and writes nothing more.
    if (!threads[taskThread].messages.some(x => x.changeSetId === body.changeSetId)) { task = { ...task, ...body, ownerName: body.ownerId !== undefined ? people[body.ownerId] ?? null : task.ownerName, revision: task.revision + 1 }; delete task.changeSetId; delete task.expectedRevision; append(taskThread, changes, body.changeSetId); }
    return json(200, { ...task, changeSetId: body.changeSetId });
   }
   const step = steps.find(s => p === `/tasks/${s.id}`);
   if (step && method === 'PATCH') {
    expect(body.expectedRevision).toBe(step.revision);
    const done = body.status === 'done'; steps = steps.map(s => s.id === step.id ? { ...s, status: body.status, revision: s.revision + 1, completedBy: done ? user : null, completedAt: done ? at : null } : s);
    task = { ...task, revision: task.revision }; append(taskThread, [change('task', taskId, { itemKind: 'step', itemId: step.id, field: 'status', before: step.status, after: body.status })], body.changeSetId);
    return json(200, { ...steps.find(s => s.id === step.id), changeSetId: body.changeSetId });
   }
   if (p === `/equipment/${tank}/reservations` && method === 'GET') {
    reads.push('occupancy');
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    const rows = [booking, ...(other ? [other] : [])].filter(r => r.status === 'confirmed' && Date.parse(r.occupiedStartsAt) < Date.parse(to) && Date.parse(r.occupiedEndsAt) > Date.parse(from));
    return json(200, { reservations: rows, nextOffset: null, coverage: 'complete', from, to, timezone: zone });
   }
   if (p === `/equipment/${tank}/reservations/${bookingId}` && method === 'GET') return json(200, booking);
   if (p === `/equipment/${tank}/reservations/${bookingId}` && method === 'PATCH') {
    expect(body.expectedRevision).toBe(booking.revision); expect([body.kind, body.taskId, body.ownerId, body.tagIds]).toEqual(['booking', null, null, undefined]);
    if (once('booking') === 'conflict') { other = { ...booking, id: holder, title: 'Bright tank clean', startsAt: '2026-10-08T01:00:00.000Z', endsAt: '2026-10-08T03:00:00.000Z', setupMinutes: 0, cleanupMinutes: 0, occupiedStartsAt: '2026-10-08T01:00:00.000Z', occupiedEndsAt: '2026-10-08T03:00:00.000Z', revision: 1 }; return json(409, { ok: false, code: 'reservation_conflict', error: 'That equipment is unavailable.' }); }
    const changes = ['startsAt', 'endsAt', 'setupMinutes', 'cleanupMinutes', 'title'].filter(k => k.endsWith('At') ? Date.parse(body[k]) !== Date.parse(booking[k]) : body[k] !== booking[k]).map(k => change('reservation', bookingId, { field: k, before: booking[k], after: body[k] }));
    booking = { ...booking, title: body.title, startsAt: body.startsAt, endsAt: body.endsAt, setupMinutes: body.setupMinutes, cleanupMinutes: body.cleanupMinutes, occupiedStartsAt: new Date(Date.parse(body.startsAt) - body.setupMinutes * 60000).toISOString(), occupiedEndsAt: new Date(Date.parse(body.endsAt) + body.cleanupMinutes * 60000).toISOString(), revision: booking.revision + 1 };
    append(bookingThread, changes, body.changeSetId); return json(200, { ...booking, changeSetId: body.changeSetId });
   }
   if (p === `/equipment/${tank}/reservations/${bookingId}/cancel`) {
    expect(body.expectedRevision).toBe(booking.revision);
    booking = { ...booking, status: 'cancelled', revision: booking.revision + 1 }; append(bookingThread, [change('reservation', bookingId, { field: 'status', before: 'confirmed', after: 'cancelled' })], body.changeSetId);
    return json(200, { ...booking, changeSetId: body.changeSetId });
   }
   if (p === `/stock/${itemId}/count`) {
    const before = stock.currentCount; stock = { ...stock, currentCount: body.count, countedAt: '2026-10-02T01:00:00.000Z' };
    append(stockThread, [change('stock_item', itemId, { field: 'currentCount', before, after: body.count }), change('stock_item', itemId, { field: 'countedAt', before: at, after: stock.countedAt }), change('stock_item', itemId, { field: 'countedBy', before: tom, after: user })], body.changeSetId);
    return json(201, { id: uuid(4000), organisationId: org, itemId, countedAt: stock.countedAt, countedBy: user, count: body.count, note: body.note ?? '', changeSetId: body.changeSetId });
   }
   return json(503, {});
  });
  page.on('pageerror', e => errors.push(e.message));
  const id = n => page.getByTestId(n).filter({ visible: true });
  const go = p => page.goto(new URL(p, production).href);
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-${scheme === 'dark' ? 'dark-' : ''}cards-${name}.png`), fullPage: true }); };
  const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const targets = async scope => { const small = await page.evaluate(sel => [...document.querySelectorAll(`${sel} input, ${sel} select, ${sel} [role="button"], ${sel} [role="checkbox"]`)].filter(e => e.offsetParent && (e.type !== 'checkbox')).map(e => { const r = e.getBoundingClientRect(); return [e.getAttribute('aria-label') ?? e.getAttribute('data-testid'), Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 44 || w < 44), scope); expect(small).toEqual([]); };
  const lineIds = thread => threads[thread].messages.filter(m => m.kind === 'change').map(m => m.id);
  const writesTo = suffix => writes.filter(w => w.path.endsWith(suffix));

  if (scheme === 'dark') {
   await go(`/threads/${taskThread}`); await id('thread-card-fold').click(); await expect(id('task-title')).toHaveValue('Package summer lager');
   await id('task-due').fill('2026-10-09'); await overflow(); await shot('task-editing');
   expect(errors).toEqual([]); expect(outside).toEqual([]); console.log(`PASS ${width}px dark: task card editing`); return;
  }

  // A thread with change lines: worded, in order among the messages, the first unread marker on a line, no menu.
  await go(`/threads/${taskThread}`); await expect(id('thread-card')).toContainText('Package summer lager');
  const [dueLine, ownerLine] = lineIds(taskThread);
  await expect(id(`change-line-${dueLine}`)).toContainText('Maya changed the due date from Tue 6 Oct to Thu 8 Oct and added the tag Production');
  await expect(id(`change-line-${ownerLine}`)).toContainText('Tom changed the owner from Maya Chen to Tom Reilly');
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="message-"]')].map(e => e.getAttribute('data-testid')).filter(t => /^message-[0-9a-f-]{36}$/.test(t)));
  expect(order).toEqual(threads[taskThread].messages.map(m => `message-${m.id}`));
  await expect(page.getByTestId(`message-${ownerLine}`).getByTestId('thread-unread-line')).toBeVisible();
  for (const l of [dueLine, ownerLine]) { await expect(page.getByTestId(`message-menu-${l}`)).toHaveCount(0); expect(await id(`change-line-${l}`).getAttribute('aria-label')).toMatch(/^(Maya|Tom) changed .+, \d/); }
  await overflow(); await shot('lines');

  // Editing a task: four fields, one save, one PATCH with one change set id; the card and thread reconcile.
  await id('thread-card-fold').click(); await expect(id('task-title')).toHaveValue('Package summer lager');
  await expect(id('task-help')).toHaveText('Saved together as one change. You can undo it from History.'); await expect(id('task-save')).toHaveAttribute('aria-disabled', 'true');
  await targets('[data-testid="task-editor"]'); await overflow(); await shot('task-open');
  await id('task-title').fill('Package summer lager cans'); await id('task-status-done').click(); await id('task-owner').selectOption(maya); await id('task-due').fill('2026-10-09');
  await expect(id('task-status-done')).toHaveAttribute('aria-pressed', 'true');
  await id('task-save').click(); await expect(id('task-save-status')).toContainText('Saved');
  const saves = writesTo(`/tasks/${taskId}`); expect(saves).toHaveLength(1);
  expect(saves[0].body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 4, title: 'Package summer lager cans', status: 'done', ownerId: maya, due: '2026-10-09' });
  const savedLine = threads[taskThread].messages.at(-1); expect(savedLine.changeSetId).toBe(saves[0].body.changeSetId);
  await expect(id(`change-line-${savedLine.id}`)).toContainText('Sam changed the title from Package summer lager to Package summer lager cans, changed the status from In progress to Done, changed the owner from Tom Reilly to Maya Chen and changed the due date from Thu 8 Oct to Fri 9 Oct');
  await expect(id('thread-fact-0')).toHaveCount(0); await id('thread-card-fold').click(); await expect(id('thread-fact-0')).toContainText('Maya Chen'); await expect(id('thread-fact-1')).toContainText('Fri 9 Oct'); await id('thread-card-fold').click();
  await expect(id('task-title')).toHaveValue('Package summer lager cans');

  // A stale revision: nothing saved, the newer task is shown and said.
  mode.task = 'stale'; await id('task-due').fill('2026-10-12'); await id('task-save').click();
  await expect(id('task-save-status')).toContainText('Someone changed this since you opened it'); await expect(id('task-title')).toHaveValue('Package the summer lager');
  await expect(id('task-due')).toHaveValue('2026-10-09'); expect(writesTo(`/tasks/${taskId}`)).toHaveLength(2); await shot('task-stale');

  // An uncertain save: the form locks; an explicit retry sends the same id and body; nothing is retried by itself.
  mode.task = 'unknown'; await id('task-due').fill('2026-10-13'); await id('task-save').click();
  await expect(id('task-save-status')).toContainText('may have been saved'); await expect(id('task-title')).toHaveAttribute('aria-disabled', 'true');
  await page.waitForTimeout(1200); expect(writesTo(`/tasks/${taskId}`)).toHaveLength(3); await overflow(); await shot('task-uncertain');
  await id('task-retry').click(); await expect(id('task-save-status')).toContainText('Saved');
  const [uncertain, retried] = writesTo(`/tasks/${taskId}`).slice(-2); expect(retried.body).toEqual(uncertain.body);
  expect(threads[taskThread].messages.at(-1).changeSetId).toBe(uncertain.body.changeSetId);
  // Sam's save, Maya's stale-time edit and Sam's retried save are consecutive lines: one folded line, the newest in full.
  const run = id(`change-run-${savedLine.id}`);
  await expect(run).toContainText('Sam changed the due date from Fri 9 Oct to Tue 13 Oct and 2 earlier changes by Sam and Maya');
  await expect(run).toHaveAttribute('role', 'button'); expect(await run.getAttribute('aria-label')).toMatch(/Show all 3 changes$/);
  await expect(page.getByTestId(`change-line-${savedLine.id}`)).toHaveCount(0); await overflow(); await shot('task-run');
  await run.click(); await expect(id(`change-line-${savedLine.id}`)).toContainText('Sam changed the title from Package summer lager to Package summer lager cans');
  await expect(id(`change-line-${threads[taskThread].messages.at(-1).id}`)).toContainText('Sam changed the due date from Fri 9 Oct to Tue 13 Oct');

  // Ticking a step saves at once, as its own change set.
  await id(`task-step-${stepA}`).check(); await expect(id('task-step-status')).toContainText('Step saved');
  const ticks = writesTo(`/tasks/${stepA}`); expect(ticks).toHaveLength(1); expect(ticks[0].body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 1, status: 'done' });
  await expect(id(`change-line-${threads[taskThread].messages.at(-1).id}`)).toContainText('Sam ticked the step Book the canning line'); await expect(id(`task-step-${stepA}`)).toBeChecked();
  expect(new Set(writes.filter(w => w.body?.changeSetId).map(w => w.body.changeSetId)).size).toBe(4, 'stale, saved, uncertain/retried and tick: four ids, the retry reusing one');
  await overflow(); await shot('task-step');

  // A booking: the occupancy note, an overlap refusal naming what holds the slot, then a save and a cancellation.
  await go(`/threads/${bookingThread}`); await id('thread-card-fold').click(); await expect(id('booking-start')).toHaveValue('08:00');
  await expect(id('booking-occupancy')).toContainText('Holds the Canning line from 7:30 am to 12:30 pm, with setup and cleanup. That time is free.');
  await expect(id('booking-equipment')).toBeDisabled(); await targets('[data-testid="booking-editor"]'); await overflow(); await shot('booking-open');
  mode.booking = 'conflict'; await id('booking-end').fill('13:00'); await expect(id('booking-occupancy')).toContainText('to 1:30 pm');
  await id('booking-save').click(); await expect(id('booking-save-status')).toContainText('unavailable during this time');
  await expect(id('booking-occupancy')).toContainText('That time overlaps Bright tank clean (12:00 pm to 2:00 pm).'); await overflow(); await shot('booking-overlap');
  await id('booking-start').fill('06:00'); await id('booking-end').fill('10:00'); await id('booking-setup').selectOption('0');
  await expect(id('booking-occupancy')).toContainText('Holds the Canning line from 6:00 am to 10:30 am, with setup and cleanup. That time is free.');
  await id('booking-save').click(); await expect(id('booking-save-status')).toContainText('Saved');
  const moves = writesTo(`/reservations/${bookingId}`); expect(moves).toHaveLength(2);
  expect(moves[1].body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 2, title: 'Summer lager canning run', kind: 'booking', startsAt: '2026-10-07T19:00:00.000Z', endsAt: '2026-10-07T23:00:00.000Z', setupMinutes: 0, cleanupMinutes: 30, taskId: null, ownerId: null });
  expect(moves[1].body.changeSetId).not.toBe(moves[0].body.changeSetId);
  await expect(id(`change-line-${threads[bookingThread].messages.at(-1).id}`)).toContainText('Sam changed the time from Thu 8 Oct, 8:00 am–12:00 pm to Thu 8 Oct, 6:00 am–10:00 am and setup from 30 minutes to none');
  await id('booking-cancel').click(); await expect(id('booking-cancel-confirm')).toContainText('Cancel this booking? The time on the Canning line becomes free for others.'); await overflow(); await shot('booking-cancel');
  await id('booking-cancel-yes').click(); await expect(id('booking-cancelled')).toContainText('This booking is cancelled');
  const cancels = writesTo(`/reservations/${bookingId}/cancel`); expect(cancels).toHaveLength(1); expect(cancels[0].body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 3 });
  // The move and the cancellation are one run by one person: folded, without actors.
  const moved = threads[bookingThread].messages.at(-2);
  await expect(id(`change-run-${moved.id}`)).toContainText('Sam cancelled the booking and 1 earlier change · '); await expect(id(`change-run-${moved.id}`)).not.toContainText(' by ');
  await id(`change-run-${moved.id}`).click(); await expect(id(`change-line-${threads[bookingThread].messages.at(-1).id}`)).toContainText('Sam cancelled the booking'); await expect(id('booking-save')).toHaveCount(0);

  // A stock count: count and note, one POST with its change set id, the line with the unit.
  await go(`/threads/${stockThread}`); await id('thread-card-fold').click(); await expect(id('stock-last')).toContainText('Last count: 4.5 kg');
  await id('stock-count').fill('6,5'); await expect(id('stock-invalid')).toBeVisible(); await expect(id('stock-save')).toHaveAttribute('aria-disabled', 'true');
  await id('stock-count').fill('6.5'); await id('stock-note').fill('Back shelf included'); await targets('[data-testid="stock-editor"]'); await overflow(); await shot('stock-open');
  await id('stock-save').click(); await expect(id('stock-save-status')).toContainText('Count saved');
  const counts = writesTo(`/stock/${itemId}/count`); expect(counts).toHaveLength(1); expect(counts[0].body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), count: '6.5', note: 'Back shelf included' });
  await expect(id(`change-line-${threads[stockThread].messages.at(-1).id}`)).toContainText('Sam changed the count from 4.5 kg to 6.5 kg'); await expect(id('stock-last')).toContainText('Last count: 6.5 kg');
  await overflow(); await shot('stock-saved');

  // The harness's synthetic states for these cards (no writes): each renders its own state without overflow.
  if (base) for (const [scenario, unfold, target] of [['threads-lines', false, 'thread-unread-line'], ['threads-card-task', true, 'task-editor'], ['threads-card-task-failed', true, 'card-record-status'],
   ['threads-card-booking', true, 'booking-occupancy'], ['threads-card-booking-cancelled', true, 'booking-cancelled'], ['threads-card-stock', true, 'stock-editor'], ['threads-card-stock-archived', true, 'stock-archived']]) {
   await page.goto(new URL(`/threads/${uuid(11)}?scenario=${scenario}`, base).href); await expect(page.getByTestId('harness-scenario')).toHaveText(scenario);
   if (unfold) await id('thread-card-fold').click();
   await expect(id(target).first()).toBeVisible(); await overflow();
  }
  expect(errors).toEqual([]); expect(outside).toEqual([]);
  console.log(`PASS ${width}px: change lines worded and ordered with the unread marker; task save (one request, one change set, reconciled), stale revision, uncertain save and same-id retry, step tick; booking overlap refusal, save and cancel; stock count${base ? '; seven harness card states' : ''}`);
 } finally { await context.close(); }
};
