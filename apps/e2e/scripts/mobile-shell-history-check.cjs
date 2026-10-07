/** R3 V-E: History, selection, the preview sheet, apply and "Make this a task", on the production export with synthetic,
 *  contract-shaped API answers (shapes from apps/api/src/versions/service.ts and threads/service.ts; apps/api/src/threads/
 *  list.test.ts feeds the real ones through the same parsers). The synthetic API keeps a small journal and applies the
 *  contract's rules (§4: slots, later changes, coupled groups, reversals that undo the earliest selected change), so a
 *  stale apply, an undo and an undo of the undo behave as the API does. Every write is recorded. Not hosted, not native,
 *  not assistive technology. */
const { expect } = require('@playwright/test'); const path = require('node:path');
module.exports = async ({ browser, production, base, shots, width, scheme = 'light' }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, colorScheme: scheme });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  // Friday 2 October 2026, 9:40 am in Sydney (AEST, +10:00): the boards' "today".
  await page.clock.setFixedTime(new Date('2026-10-01T23:40:00.000Z'));
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const org = uuid(2), maya = uuid(41), tom = uuid(42), jess = uuid(51), user = maya;
  const taskThread = uuid(11), bookingThread = uuid(12), topicThread = uuid(14), privateThread = uuid(15);
  const taskId = uuid(43), bookingId = uuid(45), tank = uuid(46), productionTag = uuid(48), autumnTag = uuid(54), lagerTag = uuid(52), keg = uuid(53);
  const orderStep = uuid(44), labelStep = uuid(50), madeTask = uuid(60);
  const zone = 'Australia/Sydney', created = '2026-09-21T00:00:00.000Z';
  const people = { [maya]: 'Maya Chen', [tom]: 'Tom Reilly', [jess]: 'Jess Park' };
  const actor = id => ({ kind: 'person', id, name: people[id] });
  let writes = [], reads = [], errors = [], outside = [], mode = {}, seq = 0, world;
  const next = () => uuid(5000 + ++seq);
  const stepRow = (id, title) => ({ id, parentId: taskId, title, body: '', status: 'open', ownerId: null, due: null, revision: 1 });
  const tagRow = (threadId, tagId) => ({ threadId, tagId, addedBy: maya, addedAt: '2026-10-01T06:40:00.000Z' });

  /** The journal: records with their current values, and change sets newest first. Entries keep their wire shape. */
  function fresh() {
   const e = (o) => ({ id: o.ids[0], changeIds: o.ids, recordKind: o.kind, recordId: o.rid, operation: o.op ?? 'update', field: o.field ?? null,
    fields: o.fields ?? ((o.op ?? 'update') === 'update' ? [o.field] : []), itemKind: o.itemKind ?? null, itemId: o.itemId ?? null, before: o.before ?? null, after: o.after ?? null,
    reverses: o.reverses ?? [], slot: o.slot ?? (o.itemId ? `i:${o.itemId}` : `f:${o.field}`), irreversible: o.irreversible ?? null, blocked: o.blocked ?? null, reversedBy: null });
   const t = (n, extra) => ({ kind: 'task', rid: taskId, ids: [uuid(n)], ...extra });
   const set = (id, who, at, changes, cause = 'request') => ({ id, actor: actor(who), causeKind: cause, reversesChangeSetId: null, createdAt: at, changes });
   const w = {
    records: {
     [`task:${taskId}`]: { revision: 5, values: { due: '2026-10-08', ownerId: tom }, items: { [`i:${productionTag}`]: tagRow(taskThread, productionTag), [`i:${orderStep}`]: stepRow(orderStep, 'Order pallet wrap'), [`i:${labelStep}`]: stepRow(labelStep, 'Check label stock') } },
     [`reservation:${bookingId}`]: { revision: 3, values: { time: { startsAt: '2026-10-09T02:00:00+00:00', endsAt: '2026-10-09T06:00:00+00:00' } }, items: {} },
     [`thread:${topicThread}`]: { revision: 2, values: {}, items: { [`i:${lagerTag}`]: tagRow(topicThread, lagerTag) } }
    },
    sets: {
     [`task:${taskId}`]: [
      set(uuid(201), tom, '2026-10-01T23:12:00.000Z', [e(t(301, { field: 'ownerId', before: maya, after: tom }))]),
      set(uuid(202), maya, '2026-10-01T06:40:00.000Z', [e(t(302, { field: 'due', before: '2026-10-06', after: '2026-10-08' })), e(t(303, { op: 'attach', itemKind: 'tag', itemId: productionTag, after: tagRow(taskThread, productionTag) }))]),
      set(uuid(203), maya, '2026-09-30T04:14:00.000Z', [e(t(304, { field: 'due', before: '2026-10-02', after: '2026-10-06' })), e(t(305, { op: 'create', itemKind: 'step', itemId: orderStep, after: stepRow(orderStep, 'Order pallet wrap') }))]),
      { ...set(uuid(204), maya, '2026-09-29T23:00:00.000Z', [e(t(306, { op: 'create', itemKind: 'step', itemId: labelStep, after: stepRow(labelStep, 'Check label stock'), reverses: [uuid(307)] }))], 'reversal'), reversesChangeSetId: uuid(205) },
      set(uuid(205), tom, '2026-09-29T01:05:00.000Z', [e(t(307, { op: 'remove', itemKind: 'step', itemId: labelStep, before: stepRow(labelStep, 'Check label stock') })),
       e(t(308, { op: 'attach', itemKind: 'tag', itemId: autumnTag, after: tagRow(taskThread, autumnTag), irreversible: 'tag_gone' }))])
     ],
     [`reservation:${bookingId}`]: [
      set(uuid(211), jess, '2026-10-01T22:05:00.000Z', [e({ kind: 'reservation', rid: bookingId, ids: [uuid(311), uuid(312)], field: 'time', fields: ['startsAt', 'endsAt'], slot: 'f:time',
       before: { startsAt: '2026-10-07T21:00:00+00:00', endsAt: '2026-10-08T01:00:00+00:00' }, after: { startsAt: '2026-10-09T02:00:00+00:00', endsAt: '2026-10-09T06:00:00+00:00' },
       blocked: { reason: 'slot_taken', detail: { reservationId: keg, title: 'Keg wash', ownerId: tom, ownerName: 'Tom Reilly', occupiedStartsAt: '2026-10-07T20:30:00.000Z', occupiedEndsAt: '2026-10-08T01:30:00.000Z' } } })]),
      set(uuid(212), maya, '2026-10-01T06:38:00.000Z', [e({ kind: 'reservation', rid: bookingId, ids: [uuid(313)], op: 'create', slot: 'record', irreversible: 'record_created',
       after: { id: bookingId, title: 'Summer lager canning run', status: 'confirmed', startsAt: '2026-10-07T21:00:00+00:00', endsAt: '2026-10-08T01:00:00+00:00' } })])
     ],
     [`thread:${topicThread}`]: [set(uuid(221), tom, '2026-10-01T22:45:00.000Z', [e({ kind: 'thread', rid: topicThread, ids: [uuid(321)], op: 'attach', itemKind: 'tag', itemId: lagerTag, after: tagRow(topicThread, lagerTag) })])]
    },
    starts: { [`task:${taskId}`]: { kind: 'baseline', changeSetId: uuid(200), at: created, revision: 1 }, [`reservation:${bookingId}`]: { kind: 'created', changeSetId: uuid(212), at: '2026-10-01T06:38:00.000Z', revision: 1 },
     [`thread:${topicThread}`]: { kind: 'first_change', changeSetId: uuid(221), at: '2026-10-01T22:45:00.000Z', revision: 2 } },
    names: { people, tags: { [productionTag]: 'Production', [autumnTag]: 'Autumn range', [lagerTag]: 'Summer lager' } },
    topic: 'topic', lines: { [taskThread]: [], [bookingThread]: [], [topicThread]: [] }
   };
   // Tom's removal of a step was undone by Maya on Wed 30 Sep.
   w.sets[`task:${taskId}`][4].changes[0].reversedBy = { changeId: uuid(306), changeSetId: uuid(204), actor: actor(maya), at: '2026-09-29T23:00:00.000Z' };
   // The first two change sets on the task are also change lines in its thread.
   w.lines[taskThread] = [line(taskThread, 2, w.sets[`task:${taskId}`][1]), line(taskThread, 4, w.sets[`task:${taskId}`][0])];
   return w;
  }
  function line(thread, n, set) {
   return { id: uuid(1000 + n + (thread === taskThread ? 0 : 100)), threadId: thread, kind: 'change', seq: n, changeSeq: n, authorId: set.actor.id, authorName: set.actor.name, body: null, createdAt: set.createdAt, editedAt: null, deletedAt: null, deletedBy: null, revision: 1,
    changeSetId: set.id, change: { actorKind: 'person', actorId: set.actor.id, actorName: set.actor.name, causeKind: set.causeKind, createdAt: set.createdAt, truncated: false,
     changes: set.changes.flatMap(c => c.field === 'time' ? c.fields.map((f, i) => ({ id: c.changeIds[i], recordKind: c.recordKind, recordId: c.recordId, operation: 'update', field: f, itemKind: null, itemId: null, before: c.before[f], after: c.after[f] }))
      : [{ id: c.id, recordKind: c.recordKind, recordId: c.recordId, operation: c.operation, field: c.field, itemKind: c.itemKind, itemId: c.itemId, before: c.before, after: c.after }]) } };
  }
  const said = (thread, n, who, body, at) => ({ id: uuid(1500 + n + (thread === taskThread ? 0 : thread === bookingThread ? 20 : 40)), threadId: thread, kind: 'message', seq: n, changeSeq: n, authorId: who, authorName: people[who], body, createdAt: at, editedAt: null, deletedAt: null, deletedBy: null, revision: 1 });
  const messagesOf = thread => {
   const base = thread === taskThread ? [said(taskThread, 1, tom, 'Labels are delayed. The printer says Wednesday now, not Monday.', '2026-10-01T03:58:00.000Z'), said(taskThread, 3, maya, 'Moved it to Thursday so the labels are here first.', '2026-10-01T06:41:00.000Z')]
    : thread === bookingThread ? [said(bookingThread, 1, tom, 'Thursday morning works for the crew.', '2026-10-01T04:14:00.000Z')]
     : [said(topicThread, 1, tom, 'Order pallet wrap before the canning run. We have one roll left.', '2026-10-01T22:41:00.000Z')];
   return [...base, ...world.lines[thread]].sort((a, b) => a.seq - b.seq);
  };
  const all = key => world.sets[key].flatMap(s => s.changes.map(c => ({ c, s }))).sort((a, b) => Date.parse(a.s.createdAt) - Date.parse(b.s.createdAt) || (a.c.id < b.c.id ? -1 : 1));
  const later = (key, c) => { const list = all(key), i = list.findIndex(x => x.c === c); return list.slice(i + 1).filter(x => x.c.slot === c.slot && !x.c.reversedBy); };
  const state = (key, c) => {
   if (c.reversedBy) return { state: 'reversed', reversedBy: c.reversedBy };
   if (c.irreversible) return { state: 'irreversible', reason: c.irreversible };
   const l = later(key, c);
   if (l.length) return { state: 'conflict', later: l.map(x => ({ id: x.c.id, changeSetId: x.s.id, actor: x.s.actor, at: x.s.createdAt, field: x.c.field, before: x.c.before, after: x.c.after })) };
   return { state: 'reversible' };
  };
  const wire = (key, c) => { const { slot, irreversible, blocked, reversedBy, ...rest } = c; return { ...rest, ...state(key, c) }; };
  const setWire = (key, s) => ({ id: s.id, actor: s.actor, causeKind: s.causeKind, reversesChangeSetId: s.reversesChangeSetId, createdAt: s.createdAt, changes: s.changes.map(c => wire(key, c)) });
  const find = id => { for (const key of Object.keys(world.sets)) for (const s of world.sets[key]) for (const c of s.changes) if (c.changeIds.includes(id)) return { key, s, c }; return null; };
  const nowOf = (key, c) => { const r = world.records[key]; if (c.itemId) return r.items[c.slot] ?? null; return c.field === 'time' ? Object.fromEntries(c.fields.map(f => [f, r.values.time[f]])) : r.values[c.field] ?? null; };
  /** The preview by the contract's rules, against the journal now. */
  function preview(ids) {
   const picked = [...new Map(ids.map(id => find(id)).filter(Boolean).map(x => [x.c.id, x])).values()];
   if (picked.length !== new Set(ids.map(id => find(id)?.c.id)).size || ids.some(id => !find(id))) return null;
   const changes = picked.map(({ key, s, c }) => {
    const base = wire(key, c), now = nowOf(key, c);
    if (base.state === 'conflict') { const left = base.later.filter(l => !ids.includes(l.id)); if (!left.length) Object.assign(base, { state: 'reversible' }), delete base.later; else base.later = left; }
    if (base.state === 'reversible' && c.changeIds.some(id => !ids.includes(id))) { delete base.later; return { ...base, state: 'needs', needs: c.changeIds.filter(id => !ids.includes(id)), now, proposed: null }; }
    if (base.state !== 'reversible') return { ...base, now, proposed: null };
    // The earliest selected change of this slot decides the value.
    const earliest = all(key).filter(x => x.c.slot === c.slot && x.c.changeIds.some(id => ids.includes(id)))[0].c;
    const proposed = c.itemId ? (['attach', 'create'].includes(earliest.operation) ? null : earliest.before) : earliest.before;
    if (c.blocked) return { ...base, state: 'blocked', reason: c.blocked.reason, detail: c.blocked.detail, now, proposed };
    if (JSON.stringify(proposed) === JSON.stringify(now)) return { ...base, state: 'blocked', reason: 'already_current', now, proposed };
    return { ...base, now, proposed };
   });
   const keys = [...new Set(picked.map(x => x.key))].sort();
   return { changes, basis: keys.map(k => ({ recordKind: k.split(':')[0], recordId: k.split(':')[1], revision: world.records[k].revision })), applicable: changes.every(c => c.state === 'reversible'), names: world.names };
  }
  /** Someone else's change a moment ago (Tom moves the due date at 9:30 am). */
  function tomMovesDue() {
   const key = `task:${taskId}`, r = world.records[key];
   const set = { id: uuid(231), actor: actor(tom), causeKind: 'request', reversesChangeSetId: null, createdAt: '2026-10-01T23:30:00.000Z',
    changes: [{ id: uuid(331), changeIds: [uuid(331)], recordKind: 'task', recordId: taskId, operation: 'update', field: 'due', fields: ['due'], itemKind: null, itemId: null, before: r.values.due, after: '2026-10-09', reverses: [], slot: 'f:due', irreversible: null, blocked: null, reversedBy: null }] };
   world.sets[key].unshift(set); r.values.due = '2026-10-09'; r.revision++;
   world.lines[taskThread].push(line(taskThread, messagesOf(taskThread).at(-1).seq + 1, set));
  }
  function apply(body) {
   const p = preview(body.changeIds);
   if (!p) return [404, { ok: false, code: 'not_found', error: 'not found' }];
   const moved = p.basis.filter(b => !body.basis.some(s => s.recordKind === b.recordKind && s.recordId === b.recordId && s.revision === b.revision));
   if (!p.applicable || moved.length) return [409, { ok: false, code: 'stale_preview', error: 'Nothing was undone.', preview: p, moved }];
   const key = find(body.changeIds[0]).key, r = world.records[key], at = new Date(Date.parse('2026-10-01T23:31:00.000Z') + seq * 60000).toISOString();
   const set = { id: body.id, actor: actor(user), causeKind: 'reversal', reversesChangeSetId: null, createdAt: at, changes: [] };
   const slots = [...new Set(p.changes.map(c => find(c.id).c.slot))];
   for (const slot of slots) {
    const chosen = all(key).filter(x => x.c.slot === slot && x.c.changeIds.some(id => body.changeIds.includes(id)));
    const earliest = chosen[0].c, now = nowOf(key, earliest), id = next();
    let c;
    if (earliest.itemId) {
     const op = { attach: 'detach', detach: 'attach', create: 'remove', remove: 'create' }[earliest.operation];
     c = { id, changeIds: [id], recordKind: earliest.recordKind, recordId: earliest.recordId, operation: op, field: null, fields: [], itemKind: earliest.itemKind, itemId: earliest.itemId,
      before: ['detach', 'remove'].includes(op) ? now : null, after: ['attach', 'create'].includes(op) ? earliest.before : null, reverses: [earliest.id], slot, irreversible: null, blocked: null, reversedBy: null };
     if (['detach', 'remove'].includes(op)) delete r.items[slot]; else r.items[slot] = earliest.before;
    } else {
     c = { id, changeIds: [id], recordKind: earliest.recordKind, recordId: earliest.recordId, operation: 'update', field: earliest.field, fields: [earliest.field], itemKind: null, itemId: null,
      before: now, after: earliest.before, reverses: [earliest.id], slot, irreversible: null, blocked: null, reversedBy: null };
     r.values[earliest.field] = earliest.before;
    }
    set.changes.push(c);
    for (const x of chosen) x.c.reversedBy = { changeId: id, changeSetId: body.id, actor: actor(user), at };
   }
   set.reversesChangeSetId = all(key).find(x => x.c.changeIds.some(i => body.changeIds.includes(i))).s.id;
   world.sets[key].unshift(set); r.revision++;
   const thread = key.startsWith('task') ? taskThread : key.startsWith('reservation') ? bookingThread : topicThread;
   world.lines[thread].push(line(thread, messagesOf(thread).at(-1).seq + 1, set));
   return [201, { changeSet: setWire(key, set), reversed: [...body.changeIds].sort() }];
  }
  const threadOf = id => ({ [taskThread]: 'task', [bookingThread]: 'booking', [topicThread]: world.topic }[id]);
  const detail = id => {
   const kind = threadOf(id), msgs = messagesOf(id), last = msgs.at(-1)?.seq ?? 0;
   const thread = (title, k = 'record') => ({ id, kind: k, title, revision: id === topicThread ? world.records[`thread:${topicThread}`].revision : 1, lastSeq: last, lastChange: last, readPosition: last, unread: 0, starred: false, createdAt: created });
   const r = world.records[`task:${taskId}`];
   if (kind === 'task') return { thread: thread('Package summer lager'), card: { record: { kind: 'task', id: taskId }, title: 'Package summer lager', status: 'in_progress', facts: [people[r.values.ownerId], r.values.due],
    fold: { body: '', status: 'in_progress', ownerId: r.values.ownerId, ownerName: people[r.values.ownerId], due: r.values.due, evidenceRequired: false, seriesId: null, open: null } }, tags: [{ id: lagerTag, name: 'Summer lager' }, ...(r.items[`i:${productionTag}`] ? [{ id: productionTag, name: 'Production' }] : [])], pin: null };
   if (kind === 'booking') return { thread: thread('Summer lager canning run'), card: { record: { kind: 'booking', id: bookingId }, title: 'Summer lager canning run', status: 'confirmed', facts: ['Canning line', '2026-10-09T02:00:00Z'],
    fold: { equipmentId: tank, equipmentName: 'Canning line', kind: 'booking', status: 'confirmed', startsAt: '2026-10-09T02:00:00.000Z', endsAt: '2026-10-09T06:00:00.000Z', setupMinutes: 0, cleanupMinutes: 0, taskId: null, ownerId: null, ownerName: null, open: { kind: 'equipment', equipmentId: tank } } }, tags: [], pin: null };
   if (kind === 'topic') return { thread: thread('Order pallet wrap before the canning run', 'topic'), card: { record: null, title: 'Order pallet wrap before the canning run', status: null, facts: ['Tom Reilly', '3'], fold: { createdBy: tom, open: null } }, tags: [{ id: lagerTag, name: 'Summer lager' }], pin: null };
   return { thread: thread('Order pallet wrap before the canning run'), card: { record: { kind: 'task', id: madeTask }, title: 'Order pallet wrap before the canning run', status: 'open', facts: ['Maya Chen', '2026-10-05'],
    fold: { body: '', status: 'open', ownerId: maya, ownerName: 'Maya Chen', due: '2026-10-05', evidenceRequired: false, seriesId: null, open: null } }, tags: [{ id: lagerTag, name: 'Summer lager' }], pin: null };
  };
  const taskRow = (id, title, x = {}) => ({ id, parentId: null, title, body: '', status: 'in_progress', ownerId: tom, ownerName: 'Tom Reilly', due: '2026-10-08', sourceKind: 'person', sourceId: maya, seriesId: null, periodStart: null, periodEnd: null,
   evidenceRequired: false, completedBy: null, completedAt: null, revision: 5, createdAt: created, updatedAt: created, evidenceCount: 0, evidence: [], ...x });

  await context.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (![production.origin, base?.origin].includes(url.origin)) { outside.push(url.origin); return route.abort(); }
   const json = (status, value, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(value) });
   if (!url.pathname.startsWith('/v1/')) { const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1'; return route.fetch({ url: upstream.href, maxRedirects: 0 }).then(response => route.fulfill({ response })).catch(() => { /* the page closed with the file in flight (a font swapping in) */ }); }
   expect(req.headers()['x-captain-client']).toBe('web'); expect(req.headers().authorization).toBeUndefined();
   const p = url.pathname.replace(`/v1/organisations/${org}`, ''), method = req.method(), body = req.postData() ? req.postDataJSON() : undefined;
   if (method !== 'GET') writes.push({ method, path: p, body }); else reads.push(p + url.search);
   if (url.pathname === '/v1/me') return json(200, { user: { id: user, name: 'Maya Chen', email: 'maya@example.test' }, memberships: [{ organisationId: org, organisationName: 'Tidewater Brewing', role: 'member', status: 'active' }], passkeyVerified: true });
   if (url.pathname === '/v1/me/passkeys') return json(200, { available: false, passkeys: [] });
   if (p === '') return json(200, { id: org, name: 'Tidewater Brewing', timezone: zone, locale: 'en-AU', createdAt: created, role: 'member' });
   if (p === '/members') return json(200, { members: [maya, tom, jess].map(userId => ({ userId, name: people[userId], email: `${people[userId].split(' ')[0].toLowerCase()}@example.test`, role: 'member', status: 'active', since: created })) });
   if (p === '/tags') return json(200, { tags: [[productionTag, 'Production'], [lagerTag, 'Summer lager']].map(([id, name]) => ({ id, name, createdAt: created, updatedAt: created, ownerId: null, startsOn: null, endsOn: null, createdBy: null, revision: 1, archivedAt: null })), nextOffset: null });
   if (p.startsWith(`/threads/${privateThread}`)) return json(404, { ok: false, code: 'not_found', error: 'not found' });
   const thread = [taskThread, bookingThread, topicThread].find(id => p.startsWith(`/threads/${id}`));
   if (thread) {
    const rest = p.slice(`/threads/${thread}`.length), msgs = messagesOf(thread), last = msgs.at(-1)?.seq ?? 0;
    if (rest === '' && method === 'GET') return json(200, detail(thread));
    if (rest === '/messages') return json(200, { thread: { id: thread, revision: detail(thread).thread.revision, lastSeq: last, lastChange: last }, messages: msgs, hasMore: false });
    if (rest === '/changes') { const after = Number(url.searchParams.get('after')); return json(200, { thread: { id: thread, revision: detail(thread).thread.revision, lastSeq: last, highWater: last }, changes: msgs.filter(m => m.changeSeq > after).map(message => ({ changeSeq: message.changeSeq, kind: 'message', message })), next: last, complete: true }); }
    if (rest === '/read') return json(200, { readPosition: body.seq, unread: 0 });
    if (rest === '/task' && method === 'POST') {
     if (body.ownerId === jess && !mode.ownerOk) { mode.ownerOk = true; return json(400, { ok: false, code: 'owner_invalid', error: 'The owner must be an active member of the organisation.' }); }
     expect(body.expectedRevision).toBe(world.records[`thread:${topicThread}`].revision);
     world.topic = 'made'; world.records[`thread:${topicThread}`].revision++;
     const set = { id: body.changeSetId, actor: actor(user), causeKind: 'request', reversesChangeSetId: null, createdAt: '2026-10-01T23:41:00.000Z', changes: [{ id: next(), changeIds: [], recordKind: 'task', recordId: madeTask, operation: 'create', field: null, fields: [], itemKind: null, itemId: null, before: null, after: { id: madeTask, title: 'Order pallet wrap before the canning run' }, reverses: [] }] };
     set.changes[0].changeIds = [set.changes[0].id];
     world.lines[topicThread].push(line(topicThread, last + 1, set));
     return json(200, detail(topicThread), { 'change-set-id': body.changeSetId });
    }
    return json(503, {});
   }
   if (p === `/tasks/${taskId}`) return json(200, { task: taskRow(taskId, 'Package summer lager'), parent: null, series: null, checklist: { tasks: Object.values(world.records[`task:${taskId}`].items).filter(i => i.parentId).map(i => taskRow(i.id, i.title, { parentId: taskId, status: 'open', ownerId: null, ownerName: null, due: null, revision: 1 })), nextOffset: null }, evidenceNextOffset: null, tags: { items: [], nextOffset: null }, today: '2026-10-02', timezone: zone });
   if (p === `/tasks/${madeTask}`) return json(200, { task: taskRow(madeTask, 'Order pallet wrap before the canning run', { status: 'open', ownerId: maya, ownerName: 'Maya Chen', due: '2026-10-05', revision: 1 }), parent: null, series: null, checklist: { tasks: [], nextOffset: null }, evidenceNextOffset: null, tags: { items: [], nextOffset: null }, today: '2026-10-02', timezone: zone });
   if (p === `/equipment/${tank}/reservations/${bookingId}`) return json(200, { id: bookingId, equipmentId: tank, title: 'Summer lager canning run', kind: 'booking', status: 'confirmed', startsAt: '2026-10-09T02:00:00.000Z', endsAt: '2026-10-09T06:00:00.000Z', setupMinutes: 0, cleanupMinutes: 0, occupiedStartsAt: '2026-10-09T02:00:00.000Z', occupiedEndsAt: '2026-10-09T06:00:00.000Z', taskId: null, ownerId: null, createdBy: maya, revision: 3, createdAt: created, updatedAt: created, tagIds: [] });
   if (p === `/equipment/${tank}/reservations`) return json(200, { reservations: [], nextOffset: null, coverage: 'complete', from: url.searchParams.get('from'), to: url.searchParams.get('to'), timezone: zone });
   const history = /^\/history\/([a-z_]+)\/([0-9a-f-]{36})(\/versions\/(\d+))?$/.exec(p);
   if (history) {
    const key = `${history[1]}:${history[2]}`;
    if (!world.sets[key]) return json(404, { ok: false, code: 'not_found', error: 'not found' });
    if (history[4]) return json(200, { recordKind: history[1], recordId: history[2], revision: Number(history[4]), changeSetId: world.starts[key].changeSetId, createdAt: world.starts[key].at, removed: false,
     snapshot: { row: { id: taskId, title: 'Package summer lager', status: 'open', ownerId: maya, due: '2026-10-02', body: '' }, steps: [{ id: labelStep, title: 'Check label stock', status: 'open' }], evidence: [], tags: [lagerTag] } });
    if (once('history') === 'fail') return json(503, {});
    // Three change sets a page, so "Show earlier changes" pages by cursor.
    const sets = world.sets[key], from = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : 0, pageSets = sets.slice(from, from + 3), more = from + 3 < sets.length;
    return json(200, { record: { kind: history[1], id: history[2], revision: world.records[key].revision, exists: true }, changeSets: pageSets.map(s => setWire(key, s)), nextCursor: more ? String(from + 3) : null,
     start: more ? null : world.starts[key], names: world.names });
   }
   if (p === '/reversals/preview') { const value = preview(body.changeIds); return value ? json(200, value) : json(404, { ok: false, code: 'not_found', error: 'not found' }); }
   if (p === '/reversals') {
    const m = once('apply');
    if (m === 'unknown') return json(503, {});
    if (m === 'stale') tomMovesDue();
    // The same id again answers the first result.
    const done = Object.entries(world.sets).flatMap(([key, sets]) => sets.filter(s => s.id === body.id).map(s => [key, s]))[0];
    if (done) return json(201, { changeSet: setWire(done[0], done[1]), reversed: [...body.changeIds].sort() }, { 'change-set-id': body.id });
    const [status, value] = apply(body); return json(status, value, status === 201 ? { 'change-set-id': body.id } : {});
   }
   return json(503, {});
  });
  const once = key => { const m = mode[key]; delete mode[key]; return m; };
  page.on('pageerror', e => errors.push(e.message));
  const id = n => page.getByTestId(n).filter({ visible: true });
  const go = p => page.goto(new URL(p, production).href);
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-${scheme === 'dark' ? 'dark-' : ''}history-${name}.png`), fullPage: false }); };
  const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const targets = async scope => { const small = await page.evaluate(sel => [...document.querySelectorAll(`${sel} input, ${sel} select, ${sel} [role="button"], ${sel} [role="link"]`)].filter(e => e.offsetParent && e.type !== 'checkbox').map(e => { const r = e.getBoundingClientRect(); return [e.getAttribute('aria-label') ?? e.textContent, Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 44 || w < 44), scope); expect(small).toEqual([]); };
  const checkboxes = async () => { const small = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="history-entry-"] label')].map(e => { const r = e.getBoundingClientRect(); return Math.round(r.height); }).filter(h => h < 44)); expect(small).toEqual([]); };
  const reset = async () => { world = fresh(); mode = {}; writes = []; reads = []; await page.evaluate(() => sessionStorage.clear()).catch(() => {}); };
  const e = n => uuid(n);
  const tick = n => id(`history-tick-${e(n)}`);
  const history = `/threads/${taskThread}/history`;
  const previewsTo = () => writes.filter(w => w.path === '/reversals/preview');
  const appliesTo = () => writes.filter(w => w.path === '/reversals');

  if (scheme === 'dark') {
   await reset(); await go(history); await expect(id('history-heading')).toBeVisible(); await expect(id(`history-entry-${e(301)}`)).toBeVisible();
   await tick(302).check(); await tick(303).check(); await overflow(); await shot('selected');
   await id('history-preview').click(); await expect(id('undo-apply')).not.toHaveAttribute('aria-disabled', 'true'); await overflow(); await shot('preview');
   await page.keyboard.press('Escape'); await expect(id('undo-sheet')).toHaveCount(0);
   await id('history-clear').click(); await tick(304).check(); await id('history-preview').click(); await expect(id(`undo-conflict-${e(304)}`)).toBeVisible(); await shot('conflict');
   expect(errors).toEqual([]); expect(outside).toEqual([]); console.log(`PASS ${width}px dark: History, ticked bar, preview and conflict sheets`); return;
  }

  // Entering History from a change line: it opens at that change set.
  await reset(); await go(`/threads/${taskThread}`); await expect(id('thread-card')).toContainText('Package summer lager');
  const dueLine = world.lines[taskThread][0];
  await expect(id(`change-line-${dueLine.id}`)).toHaveAttribute('role', 'link');
  await id(`change-line-${dueLine.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${taskThread}/history\\?changeSet=${uuid(202)}$`));
  await expect(id('history-heading')).toHaveText('History'); await expect(page.getByRole('button', { name: 'Package summer lager', exact: true })).toBeVisible();
  await expect(page.getByText('Newest first. Tick changes to undo them.')).toBeVisible();

  // Every state: tickable; "Changed since" (still tickable, explained); "Undone" and "Can't undo" (no tick box, why).
  await expect(id(`history-entry-${e(301)}`)).toContainText('Changed the owner from Maya Chen to Tom Reilly');
  await expect(id(`history-set-${uuid(201)}`)).toContainText('Tom Reilly · Today, 9:12 am');
  await expect(id(`history-set-${uuid(202)}`)).toContainText('Maya Chen · Thu 1 Oct, 4:40 pm');
  await expect(id(`history-entry-${e(302)}`)).toContainText('Changed the due date from Tue 6 Oct to Thu 8 Oct');
  await expect(id(`history-entry-${e(303)}`)).toContainText('Added the tag Production');
  await expect(id(`history-entry-${e(304)}`)).toContainText('Changed the due date from Fri 2 Oct to Tue 6 Oct');
  await expect(id(`history-badge-${e(304)}`)).toHaveText('Changed since'); await expect(id(`history-note-${e(304)}`)).toHaveText('The due date was changed again on Thu 1 Oct.');
  await expect(tick(304)).toBeEnabled(); await expect(id(`history-entry-${e(305)}`)).toContainText('Added the step Order pallet wrap');
  await expect(id('history-start')).toHaveCount(0); await expect(id('history-earlier')).toHaveText('Show earlier changes');
  await overflow(); await checkboxes(); await targets('[data-testid="history-scroll"]'); await shot('states');
  await id('history-earlier').click(); await expect(id(`history-entry-${e(307)}`)).toBeVisible();
  expect(reads.filter(r => r.startsWith(`/history/task/${taskId}`))).toEqual([`/history/task/${taskId}?limit=20`, `/history/task/${taskId}?limit=20&before=3`]);
  await expect(id(`history-set-${uuid(204)}`)).toContainText('Maya Chen · Wed 30 Sep, 9:00 am · Undo');
  await expect(id(`history-entry-${e(307)}`)).toContainText('Removed the step Check label stock'); await expect(id(`history-badge-${e(307)}`)).toHaveText('Undone');
  await expect(id(`history-note-${e(307)}`)).toHaveText('Undone by Maya Chen on Wed 30 Sep.'); await expect(page.getByTestId(`history-tick-${e(307)}`)).toHaveCount(0);
  await expect(id(`history-entry-${e(308)}`)).toContainText('Added the tag Autumn range'); await expect(id(`history-badge-${e(308)}`)).toHaveText('Can’t undo');
  await expect(id(`history-note-${e(308)}`)).toHaveText('That tag has since been deleted.'); await expect(page.getByTestId(`history-tick-${e(308)}`)).toHaveCount(0);
  await expect(id('history-start')).toContainText('History starts on Mon 21 Sep 2026, when Captain began keeping it.'); await expect(id('history-start-link')).toHaveText('See the task as it was then');
  await targets('[data-testid="history-scroll"]');
  await overflow(); await shot('states-earlier');
  await id('history-start-link').click(); await expect(id('history-version')).toContainText('Package summer lager'); await expect(id('history-version')).toContainText('Fri 2 Oct');
  await expect(id('history-version')).toContainText('Check label stock'); await expect(id('history-version')).toContainText('Summer lager');
  expect(reads).toContain(`/history/task/${taskId}/versions/1`); await overflow(); await shot('version');
  await id('history-version-back').click(); await expect(id(`history-entry-${e(301)}`)).toBeVisible();

  // Ticking and the bar; Clear; the preview with every change reversible.
  await tick(302).check(); await expect(id('history-bar-count')).toHaveText('1 change ticked'); await tick(303).check(); await expect(id('history-bar-count')).toHaveText('2 changes ticked');
  await overflow(); await targets('[data-testid="history-bar"]'); await shot('selected');
  await id('history-clear').click(); await expect(id('history-bar')).toHaveCount(0); await expect(tick(302)).not.toBeChecked();
  await tick(302).check(); await tick(303).check(); await id('history-preview').click();
  const sheet = page.getByRole('dialog'); await expect(sheet).toBeVisible();
  expect(await sheet.getAttribute('aria-labelledby')).toBe('undo-sheet-title'); await expect(page.locator('#undo-sheet-title')).toHaveText('Undo 2 changes');
  expect(previewsTo().at(-1).body).toEqual({ changeIds: [e(302), e(303)] });
  await expect(id(`undo-entry-${e(302)}`)).toContainText('Due date'); await expect(id(`undo-now-${e(302)}`)).toHaveText('Thu 8 Oct'); await expect(id(`undo-after-${e(302)}`)).toHaveText('Tue 6 Oct');
  await expect(id(`undo-entry-${e(303)}`)).toContainText('Tag Production'); await expect(id(`undo-now-${e(303)}`)).toHaveText('On this task'); await expect(id(`undo-after-${e(303)}`)).toHaveText('Removed');
  await expect(id('undo-untouched')).toHaveText('✓Everything else stays as it is, including Tom’s change of owner today.');
  await expect(page.getByText('This is added to History as a new change. Nothing is erased, and you can undo it too.')).toBeVisible();
  await expect(id('undo-apply')).toHaveText('Undo 2 changes'); await expect(id('undo-apply')).not.toHaveAttribute('aria-disabled', 'true');
  // A labelled dialog that keeps focus inside and closes with Escape.
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true); }
  await overflow(); await targets('[role="dialog"]'); await shot('preview');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(id('history-bar-count')).toHaveText('2 changes ticked');
  expect(appliesTo()).toHaveLength(0);

  // A conflict: the undo stays disabled until the person chooses; "also undo" adds the later change and previews again.
  await id('history-clear').click(); await tick(304).check(); await id('history-preview').click();
  await expect(page.locator('#undo-sheet-title')).toHaveText('Undo 1 change');
  await expect(id(`undo-entry-${e(304)}`)).toContainText('Maya changed it from Fri 2 Oct to Tue 6 Oct on Wed 30 Sep.');
  await expect(id(`undo-after-${e(304)}`)).toHaveText('Not decided');
  await expect(id(`undo-conflict-${e(304)}`)).toHaveText('⚠The due date was changed again after this: Maya moved it from Tue 6 Oct to Thu 8 Oct on Thu 1 Oct. Captain won’t choose between them.');
  await expect(id('undo-apply')).toHaveAttribute('aria-disabled', 'true');
  await expect(id(`undo-also-${e(304)}`)).toHaveText('Also undo the change of Thu 1 Oct. The due date goes back to Fri 2 Oct.');
  await expect(id(`undo-yourself-${e(304)}`)).toHaveText('Set the due date yourself instead'); await overflow(); await targets('[role="dialog"]'); await shot('conflict');
  await id(`undo-also-${e(304)}`).click(); await expect(page.locator('#undo-sheet-title')).toHaveText('Undo 2 changes');
  expect(previewsTo().at(-1).body).toEqual({ changeIds: [e(304), e(302)] });
  await expect(id(`undo-after-${e(304)}`)).toHaveText('Fri 2 Oct'); await expect(id(`undo-after-${e(302)}`)).toHaveText('Fri 2 Oct');
  await expect(id('undo-apply')).not.toHaveAttribute('aria-disabled', 'true'); await shot('conflict-resolved');
  await id('undo-cancel').click(); await expect(id('history-bar-count')).toHaveText('2 changes ticked');
  // "Set the value yourself instead" returns to the thread with the card unfolded for editing.
  await id('history-clear').click(); await tick(304).check(); await id('history-preview').click(); await id(`undo-yourself-${e(304)}`).click();
  await expect(page).toHaveURL(new RegExp(`/threads/${taskThread}(\\?|$)`)); await expect(id('task-editor')).toBeVisible();
  await expect(id('task-help')).toHaveText('Saved together as one change. You can undo it from History.');
  // The card's History link and the header's clock both open History.
  await id('thread-history-link').click(); await expect(id('history-heading')).toBeVisible(); await expect(page).toHaveURL(new RegExp(`/threads/${taskThread}/history$`));
  await page.getByRole('button', { name: 'Package summer lager', exact: true }).click(); await expect(id('thread-card')).toBeVisible();
  await id('thread-history').click(); await expect(id('history-heading')).toBeVisible(); expect(appliesTo()).toHaveLength(0);

  // A stale apply: nothing undone, what moved, the fresh preview in place; then what still applies.
  await reset(); await go(history); await tick(302).check(); await tick(303).check(); await id('history-preview').click(); await expect(id('undo-apply')).not.toHaveAttribute('aria-disabled', 'true');
  mode.apply = 'stale'; await id('undo-apply').click();
  await expect(id('undo-stale')).toHaveText('⚠Nothing was undone. Tom changed the due date at 9:30 am, so this preview was out of date. Here it is again.');
  await expect(id(`undo-badge-${e(302)}`)).toHaveText('Changed since'); await expect(id(`undo-now-${e(302)}`)).toHaveText('Fri 9 Oct'); await expect(id(`undo-after-${e(302)}`)).toHaveText('Not decided');
  await expect(id(`undo-stale-note-${e(302)}`)).toHaveText('Tom moved it from Thu 8 Oct to Fri 9 Oct at 9:30 am. Leave it, or tick Tom’s change in History as well.');
  await expect(id('undo-apply')).toHaveText('Undo the tag only'); await expect(id(`history-set-${uuid(231)}`)).toContainText('Changed the due date from Thu 8 Oct to Fri 9 Oct');
  expect(world.records[`task:${taskId}`].items[`i:${productionTag}`]).toBeTruthy(); await overflow(); await shot('stale');
  await id('undo-apply').click(); await expect(id('history-notice')).toContainText('1 change undone.');
  const [staleApply, remaining] = appliesTo(); expect(staleApply.body.changeIds).toEqual([e(302), e(303)]); expect(remaining.body.changeIds).toEqual([e(303)]);
  expect(remaining.body.id).not.toBe(staleApply.body.id); expect(remaining.body.basis).toEqual([{ recordKind: 'task', recordId: taskId, revision: 6 }]);
  await expect(page.getByTestId(/^history-set-/).first()).toContainText('Removed the tag Production');
  await id('history-earlier').click(); await expect(id(`history-badge-${e(303)}`)).toHaveText('Undone');

  // Success: one request, the new change set at the top, the reversed changes "Undone", the notice; the thread's line.
  await reset(); await go(history); await tick(302).check(); await tick(303).check(); await id('history-preview').click(); await id('undo-apply').click();
  await expect(id('history-notice')).toHaveText('✓2 changes undone. The thread shows it as a change too.');
  const applied = appliesTo(); expect(applied).toHaveLength(1);
  expect(applied[0].body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), changeIds: [e(302), e(303)], basis: [{ recordKind: 'task', recordId: taskId, revision: 5 }] });
  const undoSet = applied[0].body.id; const top = page.getByTestId(/^history-set-/).first();
  await expect(top).toHaveAttribute('data-testid', `history-set-${undoSet}`); await expect(top).toContainText('Maya Chen · Today'); await expect(top).toContainText('· Undo');
  await expect(top).toContainText('Changed the due date back from Thu 8 Oct to Tue 6 Oct'); await expect(top).toContainText('Removed the tag Production');
  for (const n of [302, 303]) { await expect(id(`history-badge-${e(n)}`)).toHaveText('Undone'); await expect(id(`history-note-${e(n)}`)).toHaveText('Undone by Maya Chen today.'); }
  await overflow(); await shot('applied');
  await id('history-earlier').click(); await expect(id(`history-note-${e(304)}`)).toHaveText('The due date was changed again today.');
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('captain.pending-undo.')))).toEqual([]);
  // Undo of the undo: the reversal is tickable like any other change.
  const undoDue = world.sets[`task:${taskId}`][0].changes[0].id;
  await tick(Number(undoDue.slice(-12))).check(); await id('history-preview').click(); await expect(id(`undo-now-${undoDue}`)).toHaveText('Tue 6 Oct'); await expect(id(`undo-after-${undoDue}`)).toHaveText('Thu 8 Oct');
  await id('undo-apply').click(); await expect(id('history-notice')).toContainText('1 change undone.'); await expect(id(`history-badge-${undoDue}`)).toHaveText('Undone');
  await expect(page.getByTestId(/^history-set-/).first()).toContainText('Changed the due date back from Tue 6 Oct to Thu 8 Oct');
  // The thread shows both undos as change lines through its feed.
  await page.getByRole('button', { name: 'Package summer lager', exact: true }).click(); await expect(id('thread-card')).toBeVisible();
  // They follow the earlier line by Maya with no message between: one folded line until tapped (owner decision, 3 October 2026).
  await expect(id(`change-run-${world.lines[taskThread].at(-3).id}`)).toContainText('Maya changed the due date back from Tue 6 Oct to Thu 8 Oct and 2 earlier changes');
  await id(`change-run-${world.lines[taskThread].at(-3).id}`).click();
  await expect(id(`change-line-${world.lines[taskThread].at(-2).id}`)).toContainText('Maya changed the due date back from Thu 8 Oct to Tue 6 Oct and removed the tag Production');
  await expect(id(`change-line-${world.lines[taskThread].at(-1).id}`)).toContainText('Maya changed the due date back from Tue 6 Oct to Thu 8 Oct');

  // An uncertain apply: the id and body kept (and only those stored); never retried by itself; the same id on retry,
  // in the sheet and again after a reload; History then shows it.
  await reset(); await go(history); await tick(301).check(); await id('history-preview').click(); mode.apply = 'unknown'; await id('undo-apply').click();
  await expect(id('undo-status')).toHaveText('This undo may have been applied. Its change ID is kept: undo again with the same ID to confirm, or check History for it.');
  await page.waitForTimeout(1200); expect(appliesTo()).toHaveLength(1); await overflow(); await shot('uncertain');
  const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k.startsWith('captain.pending-undo.')));
  expect(stored).toHaveLength(1); expect(stored[0][0]).toBe(`captain.pending-undo.${user}.${org}.${taskThread}`);
  expect(JSON.parse(stored[0][1])).toEqual(appliesTo()[0].body); expect(Object.keys(JSON.parse(stored[0][1])).sort()).toEqual(['basis', 'changeIds', 'id']);
  await page.keyboard.press('Escape'); await expect(id('undo-sheet')).toBeVisible();
  mode.apply = 'unknown'; await id('undo-retry').click(); await expect(id('undo-status')).toContainText('may have been applied');
  await page.reload(); await expect(id('history-recovered')).toContainText('An undo you started may have been applied.');
  await id('history-recovered-retry').click(); await expect(id('history-notice')).toContainText('1 change undone.');
  const tries = appliesTo(); expect(tries).toHaveLength(3); expect(tries[1].body).toEqual(tries[0].body); expect(tries[2].body).toEqual(tries[0].body);
  await expect(id(`history-badge-${e(301)}`)).toHaveText('Undone');
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('captain.pending-undo.')))).toEqual([]);

  // A booking: the time is one coupled change; its undo is blocked by a booking holding the slot.
  await reset(); await go(`/threads/${bookingThread}`); await id('thread-card-fold').click();
  await expect(id('booking-help')).toHaveText('The time, setup and cleanup are saved as one change and undone together.');
  await id('thread-history').click(); await expect(page.getByRole('button', { name: 'Summer lager canning run', exact: true })).toBeVisible();
  await expect(id(`history-entry-${e(311)}`)).toContainText('Changed the time from Thu 8 Oct, 8:00 am–12:00 pm to Fri 9 Oct, 1:00 pm–5:00 pm');
  await expect(id(`history-entry-${e(313)}`)).toContainText('Booked Summer lager canning run'); await expect(id(`history-note-${e(313)}`)).toHaveText('Cancel the booking instead.');
  await expect(id('history-start')).toContainText('History starts on Thu 1 Oct 2026, when this booking was made.'); await expect(id('history-start-link')).toHaveText('See the booking as it was then');
  await tick(311).check(); await expect(id('history-bar-count')).toHaveText('1 change ticked'); await id('history-preview').click();
  expect(previewsTo().at(-1).body).toEqual({ changeIds: [e(311), e(312)] });
  await expect(id(`undo-entry-${e(311)}`)).toContainText('Time'); await expect(id(`undo-now-${e(311)}`)).toHaveText('Fri 9 Oct, 1:00 pm to 5:00 pm'); await expect(id(`undo-after-${e(311)}`)).toHaveText('Thu 8 Oct, 8:00 am to 12:00 pm');
  await expect(id(`undo-entry-${e(311)}`)).toContainText('Start, end, setup and cleanup are undone together.');
  await expect(id(`undo-blocked-${e(311)}`)).toHaveText('⚠This can’t be undone now. Keg wash (Tom Reilly) holds the Canning line on Thu 8 Oct from 7:30 am to 12:30 pm.');
  await expect(id('undo-apply')).toHaveAttribute('aria-disabled', 'true'); await overflow(); await targets('[role="dialog"]'); await shot('blocked');
  await id(`undo-schedule-${e(311)}`).click(); await expect(page).toHaveURL(/\/equipment$/); expect(appliesTo()).toHaveLength(0);

  // A topic's own tag history (record kind thread), then "Make this a task", including a refusal.
  await reset(); await go(`/threads/${topicThread}`); await id('thread-history').click();
  await expect(id(`history-entry-${e(321)}`)).toContainText('Added the tag Summer lager'); expect(reads).toContain(`/history/thread/${topicThread}?limit=20`);
  await expect(id('history-start')).toContainText('See the thread as it was then');
  await page.getByRole('button', { name: 'Order pallet wrap before the canning run', exact: true }).click(); await id('thread-card-fold').click();
  await expect(id('make-task')).toContainText('Gives this thread an owner, a due date and steps. The messages stay here.');
  await expect(id('make-task-owner')).toHaveValue(maya); await expect(id('make-task-owner').locator('option:checked')).toHaveText('Maya Chen (you)');
  await targets('[data-testid="make-task"]'); await overflow(); await shot('make-task');
  await id('make-task-owner').selectOption(jess); await id('make-task-due').fill('2026-10-05'); await id('make-task-save').click();
  await expect(id('make-task-status')).toHaveText('The owner must be an active member of this organisation.');
  await id('make-task-owner').selectOption(maya); await id('make-task-save').click();
  await expect(id('task-editor')).toBeVisible(); await expect(id('thread-card')).toContainText('Open'); await expect(id('make-task')).toHaveCount(0);
  const made = writes.filter(w => w.path === `/threads/${topicThread}/task`); expect(made).toHaveLength(2);
  expect(made[0].body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 2, ownerId: jess, due: '2026-10-05' });
  expect(made[1].body).toEqual({ changeSetId: expect.stringMatching(/^[0-9a-f-]{36}$/), expectedRevision: 2, ownerId: maya, due: '2026-10-05' });
  expect(made[1].body.changeSetId).not.toBe(made[0].body.changeSetId);
  await expect(page.getByTestId(/^change-line-/).last()).toContainText('Maya created the task Order pallet wrap before the canning run');

  // A private thread the person is not in: History says it is not available and asks for no history.
  await reset(); await go(`/threads/${privateThread}/history`); await expect(id('history-lost')).toHaveText('This thread is no longer available.');
  expect(reads.some(r => r.startsWith('/history/'))).toBe(false); await overflow();

  // The harness's synthetic states (no writes): each renders without overflow.
  if (base) for (const [scenario, target, step] of [['threads-history', 'history-start', null], ['threads-history-failed', 'history-status', null], ['threads-history-empty', 'history-empty', null],
   ['threads-history', 'history-bar', 'tick'], ['threads-history', 'undo-untouched', 'preview'], ['threads-history-conflict', `undo-conflict-${uuid(704)}`, 'conflict'],
   ['threads-history-booking', `undo-blocked-${uuid(711)}`, 'booking'], ['threads-history-stale', 'undo-stale', 'stale'], ['threads-history-applied', 'history-set-00000000-0000-4000-8000-000000000630', null],
   ['threads-history-recovered', 'history-recovered', null], ['threads-topic-task', 'make-task', 'unfold']]) {
   const route = scenario === 'threads-topic-task' ? `/threads/${uuid(11)}` : `/threads/${uuid(11)}/history`;
   await page.goto(new URL(`${route}?scenario=${scenario}`, base).href); await expect(page.getByTestId('harness-scenario')).toHaveText(scenario);
   if (step === 'tick' || step === 'preview' || step === 'stale') { await id(`history-tick-${uuid(702)}`).check(); await id(`history-tick-${uuid(703)}`).check(); }
   if (step === 'preview' || step === 'stale') await id('history-preview').click();
   if (step === 'stale') await id('undo-apply').click();
   if (step === 'conflict') { await id(`history-tick-${uuid(704)}`).check(); await id('history-preview').click(); }
   if (step === 'booking') { await id(`history-tick-${uuid(711)}`).check(); await id('history-preview').click(); }
   if (step === 'unfold') await id('thread-card-fold').click();
   await expect(id(target).first()).toBeVisible(); await overflow();
  }
  expect(errors).toEqual([]); expect(outside).toEqual([]);
  console.log(`PASS ${width}px: History states, paging and the version; ticking and the bar; preview (all reversible, labelled dialog, focus kept, Escape); conflict then also-undo; set it yourself; card link and clock; stale apply then what remains; success with the applied state and the thread's line; undo of the undo; uncertain apply with same-id retries and reload recovery; booking time coupled and slot taken; topic history; make a task with a refusal; private thread absent${base ? '; eleven harness history states' : ''}`);
 } finally { await context.close(); }
};
