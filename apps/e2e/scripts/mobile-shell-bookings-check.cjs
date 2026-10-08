/** H2 (docs/plans/bookings-and-equipment-2026-10.md §3, §4): a new booking from the schedule (prefill from the view, the
 *  occupancy note, an overlap refused with its holder and the form kept, an uncertain write retried with the same IDs,
 *  success opening the booking's thread); "Make this a booking" on a topic, including a refusal; the Equipment screen
 *  (add, a refused name, rename, archive and unarchive with their confirm steps, Show archived); the Team row opening
 *  Members. Production export with synthetic, contract-shaped API answers (shapes from apps/api/src/{threads,equipment};
 *  apps/api/src/threads/list.test.ts feeds the real ones through the same parsers). Every write is recorded: one request
 *  per press, the client's change set id, the exact body on an explicit retry. Not hosted, native or assistive technology. */
const { expect } = require('@playwright/test'); const path = require('node:path');
module.exports = async ({ browser, production, base, shots, width, scheme = 'light' }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500, colorScheme: scheme });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const user = uuid(1), org = uuid(2), tom = uuid(42), canning = uuid(60), bright = uuid(61), topicThread = uuid(14), madeThread = uuid(70);
  const at = '2026-10-01T06:40:00.000Z', zone = 'Australia/Sydney';
  const writes = [], errors = [], outside = [];
  let mode = {}; let seq = 0;
  const once = key => { const m = mode[key]; delete mode[key]; return m; };
  /** The instant of a civil date and time in the business zone. */
  const local = (day, time) => {
   const guess = Date.parse(`${day}T${time}:00Z`);
   const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
   const g = t => parts.find(p => p.type === t).value;
   return new Date(guess - (Date.parse(`${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:00Z`) - guess)).toISOString();
  };
  const equipmentRow = (id, name, x = {}) => ({ id, name, archivedAt: null, revision: 1, createdAt: at, updatedAt: at, ...x });
  let equipment = [equipmentRow(canning, 'Canning line'), equipmentRow(bright, 'Bright tank')];
  const booking = (id, equipmentId, title, startsAt, endsAt, x = {}) => ({ id, equipmentId, title, kind: 'booking', status: 'confirmed', startsAt, endsAt, setupMinutes: 0, cleanupMinutes: 0,
   occupiedStartsAt: startsAt, occupiedEndsAt: endsAt, taskId: null, ownerId: null, createdBy: tom, revision: 1, createdAt: at, updatedAt: at, tagIds: [], ...x });
  let bookings = [];
  let topic = 'topic', made = null, topicRevision = 1;
  const row = (id, kind, title, record) => ({ id, kind, title, record, facts: ['', ''], status: record ? 'confirmed' : null, lastMessageAt: at, lastMessage: null, unread: 0, needsYou: false, starred: false, tags: [] });
  const bookingFold = b => ({ equipmentId: b.equipmentId, equipmentName: equipment.find(e => e.id === b.equipmentId)?.name ?? 'Equipment', kind: 'booking', status: b.status, startsAt: b.startsAt, endsAt: b.endsAt,
   setupMinutes: b.setupMinutes, cleanupMinutes: b.cleanupMinutes, taskId: null, ownerId: null, ownerName: null, open: { kind: 'equipment', equipmentId: b.equipmentId } });
  const threadDetail = (id) => {
   const b = id === madeThread ? made : topic === 'made' ? bookings.find(x => x.title === 'Brew the autumn lager') : null;
   const base = { id, kind: b ? 'record' : 'topic', title: b ? b.title : 'Brew the autumn lager', revision: id === topicThread ? topicRevision : 1, lastSeq: 1, lastChange: 1, readPosition: 1, unread: 0, starred: false, createdAt: at };
   return { thread: base, card: b ? { record: { kind: 'booking', id: b.id }, title: b.title, status: 'confirmed', facts: [bookingFold(b).equipmentName, b.startsAt.replace('.000', '')], fold: bookingFold(b) }
    : { record: null, title: 'Brew the autumn lager', status: null, facts: ['Tom Reilly', '1'], fold: { createdBy: tom, open: null } }, tags: [], pin: null };
  };
  const said = (thread) => ({ id: uuid(1000 + (thread === topicThread ? 1 : 2)), threadId: thread, kind: 'message', seq: 1, changeSeq: 1, authorId: tom, authorName: 'Tom Reilly',
   body: thread === topicThread ? 'Tuesday morning suits the crew for the autumn lager.' : 'Booked from the schedule.', createdAt: at, editedAt: null, deletedAt: null, deletedBy: null, revision: 1 });
  await context.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (![production.origin, base?.origin].includes(url.origin)) { outside.push(url.origin); return route.abort(); }
   const json = (status, value, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(value) });
   if (!url.pathname.startsWith('/v1/')) { const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1'; return route.fetch({ url: upstream.href, maxRedirects: 0 }).then(response => route.fulfill({ response })).catch(() => {}); }
   expect(req.headers()['x-captain-client']).toBe('web');
   const p = url.pathname.replace(`/v1/organisations/${org}`, ''), method = req.method(), body = req.postData() ? req.postDataJSON() : undefined;
   if (method !== 'GET') writes.push({ method, path: p, body });
   if (url.pathname === '/v1/me') return json(200, { user: { id: user, name: 'Sam Skipper', email: 'sam@example.test' }, memberships: [{ organisationId: org, organisationName: 'Harbour Brewing', role: 'member', status: 'active' }], passkeyVerified: true });
   if (url.pathname === '/v1/me/passkeys') return json(200, { available: false, passkeys: [] });
   if (p === '') return json(200, { id: org, name: 'Harbour Brewing', timezone: zone, locale: 'en-AU', createdAt: at, role: 'member' });
   if (p === '/members') return json(200, { members: [user, tom].map(userId => ({ userId, name: userId === user ? 'Sam Skipper' : 'Tom Reilly', email: `${userId.slice(-2)}@example.test`, role: 'member', status: 'active', since: at })) });
   if (p === '/tags') return json(200, { tags: [], nextOffset: null });
   if (p === '/threads' && method === 'GET') {
    const filter = url.searchParams.get('filter') || 'all';
    const threads = filter === 'bookings' ? [...(made ? [row(madeThread, 'record', made.title, { kind: 'booking', id: made.id })] : []), row(uuid(71), 'record', 'Keg wash', { kind: 'booking', id: uuid(72) })] : [];
    return json(200, { filter, available: true, threads, groups: [], nextCursor: null });
   }
   const thread = [topicThread, madeThread].find(id => p.startsWith(`/threads/${id}`));
   if (thread) {
    const rest = p.slice(`/threads/${thread}`.length);
    if (rest === '') return json(200, threadDetail(thread));
    if (rest === '/messages') return json(200, { thread: { id: thread, revision: 1, lastSeq: 1, lastChange: 1 }, messages: [said(thread)], hasMore: false });
    if (rest === '/changes') return json(200, { thread: { id: thread, revision: 1, lastSeq: 1, highWater: 1 }, changes: [], next: 1, complete: true });
    if (rest === '/read') return json(200, { readPosition: 1, unread: 0 });
    if (rest === '/booking' && method === 'POST') {
     expect(Object.keys(body).sort()).toEqual(['changeSetId', 'cleanupMinutes', 'endsAt', 'equipmentId', 'expectedRevision', 'setupMinutes', 'startsAt']);
     expect(body.expectedRevision).toBe(topicRevision);
     if (once('make') === 'archived') return json(409, { ok: false, code: 'equipment_archived', error: 'This equipment is archived.' });
     const b = booking(uuid(80), body.equipmentId, 'Brew the autumn lager', body.startsAt, body.endsAt, { setupMinutes: body.setupMinutes, cleanupMinutes: body.cleanupMinutes,
      occupiedStartsAt: new Date(Date.parse(body.startsAt) - body.setupMinutes * 60000).toISOString(), occupiedEndsAt: new Date(Date.parse(body.endsAt) + body.cleanupMinutes * 60000).toISOString(), createdBy: user });
     bookings.push(b); topic = 'made'; topicRevision++;
     return json(200, threadDetail(topicThread), { 'change-set-id': body.changeSetId });
    }
    return json(503, {});
   }
   if (p === '/equipment' && method === 'GET') {
    const archived = url.searchParams.get('archived') === 'true';
    return json(200, { equipment: equipment.filter(e => (e.archivedAt !== null) === archived), nextOffset: null });
   }
   if (p === '/equipment' && method === 'POST') {
    expect(Object.keys(body).sort()).toEqual(['changeSetId', 'name']);
    if (equipment.some(e => e.name.toLowerCase() === body.name.toLowerCase())) return json(409, { ok: false, code: 'equipment_name_exists', error: 'Equipment with that name already exists.' });
    const e = equipmentRow(uuid(62 + seq++), body.name); equipment.push(e); return json(201, { ...e, changeSetId: body.changeSetId });
   }
   const item = equipment.find(e => p === `/equipment/${e.id}`);
   if (item && method === 'PATCH') {
    expect(body.expectedRevision).toBe(item.revision);
    Object.assign(item, { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.archived !== undefined ? { archivedAt: body.archived ? '2026-10-08T01:00:00.000Z' : null } : {}), revision: item.revision + 1 });
    return json(200, { ...item, changeSetId: body.changeSetId });
   }
   const occupancy = equipment.find(e => p === `/equipment/${e.id}/reservations`);
   if (occupancy && method === 'GET') {
    const from = url.searchParams.get('from'), to = url.searchParams.get('to');
    const rows = bookings.filter(b => b.equipmentId === occupancy.id && b.status === 'confirmed' && Date.parse(b.occupiedStartsAt) < Date.parse(to) && Date.parse(b.occupiedEndsAt) > Date.parse(from));
    return json(200, { reservations: rows, nextOffset: null, coverage: 'complete', from, to, timezone: zone });
   }
   if (occupancy && method === 'POST') {
    expect(Object.keys(body).sort()).toEqual(['changeSetId', 'cleanupMinutes', 'endsAt', 'id', 'kind', 'ownerId', 'setupMinutes', 'startsAt', 'tagIds', 'taskId', 'title']);
    const m = once('create');
    if (m === 'unknown') return json(503, {});
    if (m === 'conflict') { bookings.push(booking(uuid(73), occupancy.id, 'Line clean', body.startsAt, body.endsAt)); return json(409, { ok: false, code: 'reservation_conflict', error: 'That equipment is unavailable during this time.' }); }
    made = booking(body.id, occupancy.id, body.title, body.startsAt, body.endsAt, { setupMinutes: body.setupMinutes, cleanupMinutes: body.cleanupMinutes, createdBy: user,
     occupiedStartsAt: new Date(Date.parse(body.startsAt) - body.setupMinutes * 60000).toISOString(), occupiedEndsAt: new Date(Date.parse(body.endsAt) + body.cleanupMinutes * 60000).toISOString() });
    bookings.push(made); return json(201, { ...made, changeSetId: body.changeSetId });
   }
   const one = bookings.find(b => p === `/equipment/${b.equipmentId}/reservations/${b.id}`);
   if (one && method === 'GET') return json(200, one);
   return json(503, {});
  });
  page.on('pageerror', e => errors.push(e.message));
  const id = n => page.getByTestId(n).filter({ visible: true });
  const go = p => page.goto(new URL(p, production).href);
  const name = n => `${width}-${scheme === 'dark' ? 'dark-' : ''}bookings-${n}.png`;
  // The browser's own time field shows its raw parts while focused; a screenshot is taken as the person sees the form after typing.
  const shot = async n => { if (shots) { await page.evaluate(() => document.activeElement?.blur?.()); await page.screenshot({ path: path.join(shots, name(n)), fullPage: true }); } };
  const overflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth)).toBeLessThanOrEqual(1);
  const targets = async scope => { const small = await page.evaluate(sel => [...document.querySelectorAll(`${sel} input, ${sel} select, ${sel} [role="button"], ${sel} [role="checkbox"]`)].filter(e => e.offsetParent && (e.type !== 'checkbox')).map(e => { const r = e.getBoundingClientRect(); return [e.getAttribute('aria-label') ?? e.getAttribute('data-testid'), Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 44 || w < 44), scope); expect(small).toEqual([]); };
  const posts = p => writes.filter(w => w.path === p);

  // The schedule offers New booking and Manage equipment; New booking opens with the equipment and the day in view.
  await go('/equipment');
  await expect(id('equipment-new-booking')).toBeVisible(); await expect(id('equipment-manage-open')).toBeVisible();
  await expect(page.getByText('Canning line', { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(600); // the view settles before the button reads it
  await overflow(); await shot('schedule');
  await id('equipment-new-booking').click();
  await expect(page.getByRole('heading', { name: 'New booking', exact: true })).toBeVisible();
  const link = new URL(page.url());
  expect(link.pathname).toBe('/equipment/new'); expect(link.searchParams.get('equipment')).toBe(canning);
  const day = link.searchParams.get('day'); expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await expect(id('new-booking-equipment')).toHaveValue(canning); await expect(id('new-booking-date')).toHaveValue(day);
  await expect(id('new-booking-equipment').locator('option')).toHaveText(['Canning line', 'Bright tank']);
  await expect(id('new-booking-save')).toBeDisabled(); // no title yet
  // Something already holds 11 am to noon on that day.
  bookings.push(booking(uuid(74), canning, 'Keg wash', local(day, '11:00'), local(day, '12:00')));
  await id('new-booking-title').fill('Can the summer lager'); await id('new-booking-start').fill('08:00'); await id('new-booking-end').fill('12:00');
  await id('new-booking-setup').selectOption('30');
  await expect(id('new-booking-occupancy')).toContainText('Holds the Canning line from 7:30 am to 12:00 pm, with setup and cleanup. That time overlaps Keg wash (11:00 am to 12:00 pm). Choose another time to save.');
  await expect(id('new-booking-save')).toBeDisabled(); await targets('[data-testid="new-booking"]'); await overflow(); await shot('new-booking-taken');
  await id('new-booking-end').fill('10:30');
  await expect(id('new-booking-occupancy')).toContainText('That time is free.'); await expect(id('new-booking-save')).toBeEnabled();
  await shot('new-booking');
  // The server refuses an overlap the schedule did not show yet: the holder is named and the form is kept.
  mode.create = 'conflict'; await id('new-booking-save').click();
  await expect(id('new-booking-status')).toHaveText('That equipment is booked during this time, including setup and cleanup. Nothing was made; choose another time.');
  await expect(id('new-booking-occupancy')).toContainText('That time overlaps Line clean');
  await expect(id('new-booking-title')).toHaveValue('Can the summer lager'); await expect(id('new-booking-save')).toBeDisabled();
  await shot('new-booking-overlap');
  await id('new-booking-start').fill('13:00'); await id('new-booking-end').fill('15:00');
  await expect(id('new-booking-occupancy')).toContainText('That time is free.');
  // An uncertain answer locks the form until an explicit retry, which sends the same IDs and body.
  mode.create = 'unknown'; await id('new-booking-save').click();
  await expect(id('new-booking-retry')).toBeVisible(); await expect(id('new-booking-retry')).toHaveText('Make again with the same ID');
  await expect(id('new-booking-title')).toBeDisabled(); await expect(id('new-booking-save')).toHaveCount(0);
  await page.waitForTimeout(400); expect(posts(`/equipment/${canning}/reservations`)).toHaveLength(2); // never retried by itself
  await id('new-booking-retry').click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/threads/${madeThread}`);
  const sent = posts(`/equipment/${canning}/reservations`);
  expect(sent).toHaveLength(3); expect(sent[2].body).toEqual(sent[1].body); expect(sent[1].body.changeSetId).not.toBe(sent[0].body.changeSetId);
  expect(sent[2].body).toMatchObject({ title: 'Can the summer lager', kind: 'booking', setupMinutes: 30, cleanupMinutes: 0, startsAt: local(day, '13:00'), endsAt: local(day, '15:00'), taskId: null, ownerId: null, tagIds: [] });
  await expect(id('thread-card')).toContainText('Can the summer lager');

  // Make this a booking on a topic: beside Make this a task; a refusal in words, then success.
  await go(`/threads/${topicThread}`); await id('thread-card-fold').click();
  await expect(id('make-task')).toBeVisible(); await expect(id('make-booking-open')).toBeVisible();
  await id('make-booking-open').click(); await expect(id('make-task')).toHaveCount(0);
  await expect(id('make-booking')).toContainText('Books equipment for this thread. The booking takes the thread’s title; the messages stay here.');
  await expect(id('make-booking-equipment')).toHaveValue(canning);
  await id('make-booking-start').fill('16:00'); await id('make-booking-end').fill('18:00');
  await expect(id('make-booking-occupancy')).toContainText('That time is free.');
  await targets('[data-testid="make-booking"]'); await overflow(); await shot('make-booking');
  mode.make = 'archived'; await id('make-booking-save').click();
  await expect(id('make-booking-status')).toHaveText('That equipment is archived, so it takes no new bookings. Choose other equipment.');
  await expect(id('make-booking-save')).toBeDisabled();
  await id('make-booking-equipment').selectOption(bright); await expect(id('make-booking-save')).toBeEnabled();
  await expect(id('make-booking-occupancy')).toContainText('That time is free.');
  await id('make-booking-save').click();
  await expect(id('booking-editor')).toBeVisible(); await expect(id('make-booking')).toHaveCount(0);
  const madeBooking = posts(`/threads/${topicThread}/booking`); expect(madeBooking).toHaveLength(2);
  expect(madeBooking[1].body).toMatchObject({ equipmentId: bright, startsAt: local(new Date().toLocaleDateString('en-CA', { timeZone: zone }), '16:00'), setupMinutes: 0, cleanupMinutes: 0 });

  // The Equipment screen: add (and a refused name), rename, archive with its confirm, Show archived, unarchive.
  await go('/equipment'); await id('equipment-manage-open').click();
  await expect(page.getByRole('heading', { name: 'Equipment', exact: true })).toBeVisible();
  await expect(id(`equipment-row-${canning}`)).toContainText('Canning line'); await expect(id(`equipment-row-${bright}`)).toContainText('Bright tank');
  await targets('[data-testid="equipment-manage"]'); await overflow(); await shot('manage');
  await id('equipment-add-name').fill('canning LINE'); await id('equipment-add-save').click();
  await expect(id('equipment-manage-status')).toHaveText('Equipment with that name already exists, including archived equipment. Choose another name.');
  await id('equipment-add-name').fill('Fermenter 3'); await id('equipment-add-save').click();
  await expect(page.getByText('Fermenter 3', { exact: true })).toBeVisible(); await expect(id('equipment-add-name')).toHaveValue('');
  await id(`equipment-rename-${bright}`).click(); await id(`equipment-rename-input-${bright}`).fill('Bright tank 2'); await id(`equipment-rename-save-${bright}`).click();
  await expect(id(`equipment-row-${bright}`)).toContainText('Bright tank 2');
  expect(writes.filter(w => w.path === `/equipment/${bright}`).at(-1).body).toMatchObject({ expectedRevision: 1, name: 'Bright tank 2' });
  await id(`equipment-archive-${bright}`).click();
  await expect(id(`equipment-confirm-${bright}`)).toContainText('Archive Bright tank 2? It leaves the schedule and the booking forms.');
  await targets(`[data-testid="equipment-confirm-${bright}"]`); await shot('manage-confirm');
  await id(`equipment-confirm-no-${bright}`).click(); await expect(id(`equipment-confirm-${bright}`)).toHaveCount(0);
  expect(writes.filter(w => w.path === `/equipment/${bright}`)).toHaveLength(1); // keeping it writes nothing
  await id(`equipment-archive-${bright}`).click(); await id(`equipment-confirm-yes-${bright}`).click();
  await expect(id(`equipment-row-${bright}`)).toHaveCount(0);
  expect(writes.filter(w => w.path === `/equipment/${bright}`).at(-1).body).toMatchObject({ expectedRevision: 2, archived: true });
  await id('equipment-manage-show-archived').click();
  await expect(page.getByRole('heading', { name: 'Archived equipment', exact: true })).toBeVisible();
  await expect(id(`equipment-row-${bright}`)).toContainText('Archived'); await shot('manage-archived');
  await id(`equipment-unarchive-${bright}`).click(); await id(`equipment-confirm-yes-${bright}`).click();
  await expect(id('equipment-manage-empty')).toHaveText('No archived equipment.');
  expect(writes.filter(w => w.path === `/equipment/${bright}`).at(-1).body).toMatchObject({ expectedRevision: 3, archived: false });
  for (const w of writes.filter(w => w.path.startsWith('/equipment') && !w.path.includes('reservations'))) expect(w.body.changeSetId).toMatch(/^[0-9a-f-]{36}$/);

  // The Team pinned row opens Members, whose way back is to Threads.
  await go('/'); await expect(id('threads-pinned-team')).not.toHaveAttribute('aria-disabled', 'true');
  await expect(id('threads-pinned-team')).toHaveAttribute('aria-label', 'Team. Members and invitations');
  await id('threads-pinned-team').click();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible(); expect(new URL(page.url()).pathname).toBe('/members');
  await expect(id('members-denied')).toBeVisible();
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Threads', exact: true })).toBeVisible();

  expect(errors).toEqual([]); expect(outside).toEqual([]);
  console.log(`PASS ${width}px${scheme === 'dark' ? ' dark' : ''}: new booking from the schedule (prefill, occupancy note, overlap with its holder, uncertain same-ID retry, its thread); make a booking on a topic with a refusal; equipment add/refused name/rename/archive/unarchive with confirms; the Team row`);
 } finally { await context.close(); }
};
