import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { journalFields, withTenant } from '@captain/db';
import { databaseUrl, fixture, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import { groupLimit } from './service.ts';

// The R2 thread model through the API (threads contract §4–§6, §9): record threads for tasks, bookings and stock items,
// topics created by their first message, tags on threads, the one live pin, and the list with filters, cursor and
// headings. Real Postgres, as the runtime role. Each test runs in its own organisation so its list holds only its threads.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
type Chip = { id: string; name: string };
type Row = { id: string; kind: string; title: string; record: { kind: string; id: string } | null; facts: [string, string]; status: string | null;
 lastMessageAt: string | null; lastMessage: { authorName: string | null; excerpt: string } | null; unread: number; needsYou: boolean; starred: boolean;
 tags: Chip[] };
type Group = { key: string; label: string; threads: number; needsYou: number; owner: { id: string; name: string | null } | null; startsOn: string | null; endsOn: string | null };
type List = { filter: string; available: boolean; threads: Row[]; nextCursor: string | null; groups: Group[] };
type Detail = { thread: { id: string; kind: string; title: string; revision: number; lastSeq: number; readPosition: number; unread: number };
 card: { record: { kind: string; id: string } | null; title: string; status: string | null; facts: [string, string]; fold: Record<string, unknown> };
 tags: Chip[]; participants?: { userId: string }[]; pin: { id: string; messageId: string } | null };
type Message = { id: string; seq: number; kind: string; body: string | null };
type Failure = { code: string };
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
 next: { subject: 'owner', email: 'owner@example.test', name: 'Owner' },
 authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`, async exchange() { return google.next; },
};
const request = (method: string, path: string, person?: Person, data?: unknown) => app.request(path, { method,
 headers: { 'content-type': 'application/json', ...(person ? { authorization: `Bearer ${person.token}` } : {}) },
 body: data === undefined ? undefined : JSON.stringify(data) });
async function json<T>(response: Response | Promise<Response>, status = 200): Promise<T> {
 const value = await response; assert.equal(value.status, status, await value.clone().text()); return value.json() as Promise<T>;
}
async function signIn(subject: string, name: string): Promise<Person> {
 google.next = { subject, email: `${subject}@example.test`, name };
 const start = await app.request('/auth/google/start');
 const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
 const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
 const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
 return json(request('POST', '/auth/session/exchange', undefined, { code }));
}
let people = 0;
/** A business with an owner, an admin and two members, all new. */
async function business(name: string) {
 const n = ++people;
 const owner = await signIn(`list-owner-${n}`, `Olive ${n}`), admin = await signIn(`list-admin-${n}`, `Ada ${n}`);
 const member = await signIn(`list-member-${n}`, `Mia ${n}`), other = await signIn(`list-other-${n}`, `Otto ${n}`);
 const org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name }), 201)).id;
 for (const [person, role] of [[admin, 'admin'], [member, 'member'], [other, 'member']] as const)
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${person.user.id}, ${role})`;
 const base = `/v1/organisations/${org}`;
 const threads = `${base}/threads`;
 return {
  org, owner, admin, member, other, base, threads,
  list: (person: Person, query = '') => json<List>(request('GET', `${threads}${query ? `?${query}` : ''}`, person)),
  detail: (person: Person, id: string) => json<Detail>(request('GET', `${threads}/${id}`, person)),
  topic: (person: Person, body: string, id = randomUUID(), messageId = randomUUID()) => request('POST', threads, person, { id, kind: 'topic', message: { id: messageId, body } }),
  send: (person: Person, thread: string, body: string) => json<Message>(request('POST', `${threads}/${thread}/messages`, person, { id: randomUUID(), body }), 201),
  task: async (title: string, extra: Record<string, unknown> = {}) => (await json<{ id: string }>(request('POST', `${base}/tasks`, owner, { title, ...extra }), 201)).id,
  tag: async (name: string, extra: Record<string, unknown> = {}) => (await json<{ id: string; revision: number }>(request('POST', `${base}/tags`, owner, { name, ...extra }), 201)),
  threadOf: async (column: 'task_id' | 'reservation_id' | 'stock_item_id', id: string) => (await db.owner.unsafe(`select id from threads where ${column} = $1`, [id]))[0]!.id as string,
  addTag: (person: Person, thread: string, tag: string, expectedRevision: number) => request('POST', `${threads}/${thread}/tags/${tag}`, person, { expectedRevision }),
  removeTag: (person: Person, thread: string, tag: string, expectedRevision: number) => request('DELETE', `${threads}/${thread}/tags/${tag}?expectedRevision=${expectedRevision}`, person),
 };
}
type Business = Awaited<ReturnType<typeof business>>;
const tagged = async (b: Business, thread: string, tag: string) => {
 const revision = (await b.detail(b.owner, thread)).thread.revision;
 return json<Detail>(b.addTag(b.owner, thread, tag, revision));
};

before(async () => {
 if (!databaseUrl) return;
 db = await freshDatabase();
 let clock = Date.now();
 app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
  organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => (clock += 61_000)) });
});
after(async () => { await db?.close(); });

it('a topic is created by its first message in one transaction: seq 1, a derived title, retry 200 and mismatch 409', async () => {
 const b = await business('Topics');
 const id = randomUUID(), messageId = randomUUID();
 const body = '  Book the canning line  \nfor Thursday, if the kettle is free.';
 const created = await json<Detail>(b.topic(b.member, body, id, messageId), 201);
 assert.deepEqual([created.thread.kind, created.thread.title, created.thread.lastSeq, created.thread.revision], ['topic', 'Book the canning line', 1, 1]);
 assert.equal(created.participants, undefined, 'a topic has no participant list');
 assert.deepEqual(created.card.facts, [`Mia ${people}`, ''], 'created by');
 const messages = await json<{ messages: Message[] }>(request('GET', `${b.threads}/${id}/messages?latest=5`, b.owner));
 assert.deepEqual(messages.messages.map(m => [m.id, m.seq, m.body]), [[messageId, 1, body.trim()]]);
 // A retry with the same ids and an equal fingerprint: 200 and the current thread, writing nothing.
 const audit = async () => (await db.owner<{ action: string }[]>`select action from chat_audit_events where thread_id = ${id} order by created_at, id`).map(r => r.action);
 assert.deepEqual(await audit(), ['chat.thread_created', 'chat.message_sent']);
 await json(request('PATCH', `${b.threads}/${id}`, b.other, { expectedRevision: 1, title: 'Canning line, Thursday' }));
 const retried = await json<Detail>(b.topic(b.member, body, id, messageId), 200);
 assert.equal(retried.thread.title, 'Canning line, Thursday', 'the current thread; any member renamed it');
 assert.equal(retried.thread.lastSeq, 1);
 assert.deepEqual(await audit(), ['chat.thread_created', 'chat.message_sent', 'chat.thread_updated']);
 // Anything else under that id is the generic 409: another first line, another message id, another person.
 for (const response of [b.topic(b.member, 'Something else', id, messageId), b.topic(b.member, body, id, randomUUID()), b.topic(b.owner, body, id, messageId)])
  assert.equal((await json<Failure>(response, 409)).code, 'thread_id_unavailable');
 // A first message whose id is taken: nothing is created at all.
 const fresh = randomUUID();
 assert.equal((await json<Failure>(b.topic(b.member, 'Reusing an id', fresh, messageId), 409)).code, 'message_id_unavailable');
 assert.equal((await db.owner`select 1 from threads where id = ${fresh}`).length, 0, 'one transaction');
 // Every member sees and writes a topic; a topic's first message is required, a private thread's is optional.
 await b.send(b.other, id, 'I can do Thursday');
 assert.equal((await json<Failure>(request('POST', b.threads, b.member, { id: randomUUID(), kind: 'topic' }), 400)).code, 'invalid_request');
 const quiet = await json<Detail>(request('POST', b.threads, b.member, { id: randomUUID(), kind: 'private', title: 'Just us', participantIds: [b.owner.user.id] }), 201);
 assert.equal(quiet.thread.lastSeq, 0);
 const said = randomUUID();
 const opened = await json<Detail>(request('POST', b.threads, b.member, { id: randomUUID(), kind: 'private', title: 'With a word', participantIds: [], message: { id: said, body: 'Hello' } }), 201);
 assert.equal(opened.thread.lastSeq, 1);
 assert.equal((await request('GET', `${b.threads}/${opened.thread.id}`, b.owner)).status, 404, 'private stays participant-only');
});

it('every task, booking and stock item has a record thread with its card; a step has none and shares its task’s', async () => {
 const b = await business('Records');
 const task = await b.task('Brew batch 42', { ownerId: b.member.user.id, due: '2031-05-01', body: 'Use the new yeast.' });
 const [taskRow] = await db.owner`select revision from tasks where id = ${task}`;
 await json(request('POST', `${b.base}/tasks`, b.owner, { title: 'Weigh the malt', parentId: task, expectedParentRevision: taskRow!.revision }), 201);
 const tank = (await json<{ id: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Tank 3' }), 201)).id;
 const booking = (await json<{ id: string }>(request('POST', `${b.base}/equipment/${tank}/reservations`, b.owner,
  { id: randomUUID(), title: 'Ferment 42', kind: 'maintenance', startsAt: '2031-05-01T08:00:00Z', endsAt: '2031-05-02T08:00:00Z', taskId: task }), 201)).id;
 const item = (await json<{ id: string }>(request('POST', `${b.base}/stock`, b.owner, { name: 'Hops', location: 'Store', unitLabel: 'kg' }), 201)).id;
 assert.equal((await db.owner`select count(*)::int as n from threads t join tasks k on k.id = t.task_id where k.organisation_id = ${b.org}`)[0]!.n, 1, 'the step has no thread');
 const rows = (await b.list(b.member, 'filter=records')).threads;
 assert.equal(rows.length, 3);
 const byKind = Object.fromEntries(rows.map(r => [r.record!.kind, r]));
 assert.deepEqual([byKind.task!.title, byKind.task!.status, byKind.task!.facts], ['Brew batch 42', 'open', [`Mia ${people}`, '2031-05-01']]);
 assert.deepEqual([byKind.booking!.title, byKind.booking!.status, byKind.booking!.facts], ['Ferment 42', 'maintenance', ['Tank 3', '2031-05-01T08:00:00Z']]);
 assert.deepEqual([byKind.stock!.title, byKind.stock!.status, byKind.stock!.facts], ['Hops', 'not_counted', ['Not counted', 'Never counted']]);
 assert.deepEqual(rows.map(r => r.record!.id).sort(), [task, booking, item].sort());
 const card = (await b.detail(b.member, byKind.task!.id)).card;
 assert.deepEqual([card.record, card.title, card.fold.body, card.fold.due], [{ kind: 'task', id: task }, 'Brew batch 42', 'Use the new yeast.', '2031-05-01']);
 const bookingCard = (await b.detail(b.member, byKind.booking!.id)).card;
 assert.deepEqual(bookingCard.fold.open, { kind: 'equipment', equipmentId: tank }, 'open the record: the equipment schedule');
 // Renaming a record thread is the record's business.
 assert.equal((await json<Failure>(request('PATCH', `${b.threads}/${byKind.task!.id}`, b.owner, { expectedRevision: 1, title: 'Other' }), 400)).code, 'record_title');
 await json(request('PATCH', `${b.base}/tasks/${task}`, b.owner, { expectedRevision: taskRow!.revision + 1, title: 'Brew batch 43' }));
 assert.equal((await b.detail(b.member, byKind.task!.id)).thread.title, 'Brew batch 43', 'the title is the record’s, read at query time');
});

it('filters, a cursor that stays stable across a new message, and headings over the whole filtered set', async () => {
 const b = await business('Lists');
 const production = await b.tag('Production'), launch = await b.tag('Summer lager launch', { ownerId: b.member.user.id, startsOn: '2031-06-01', endsOn: '2031-08-31' });
 const tasks = [];
 for (let i = 0; i < 4; i++) tasks.push(await b.task(`Task ${i}`));
 const topics = [];
 for (let i = 0; i < 3; i++) topics.push((await json<Detail>(b.topic(b.owner, `Topic ${i}`), 201)).thread.id);
 const item = (await json<{ id: string }>(request('POST', `${b.base}/stock`, b.owner, { name: 'Malt', location: 'Store', unitLabel: 'kg' }), 201)).id;
 const taskThreads = await Promise.all(tasks.map(t => b.threadOf('task_id', t)));
 await tagged(b, taskThreads[0]!, production.id); await tagged(b, taskThreads[1]!, production.id); await tagged(b, taskThreads[1]!, launch.id);
 await tagged(b, topics[0]!, launch.id);
 const secret = (await json<Detail>(request('POST', b.threads, b.owner, { id: randomUUID(), kind: 'private', title: 'Owners only', participantIds: [] }), 201)).thread.id;
 await tagged(b, secret, production.id);

 const all = await b.list(b.member);
 assert.equal(all.threads.length, 8, '4 tasks, 3 topics and a stock item; never the private thread');
 assert.ok(!all.threads.some(t => t.id === secret));
 const ids = (list: List) => list.threads.map(t => t.id).sort();
 assert.deepEqual(ids(await b.list(b.member, 'filter=tasks')), taskThreads.slice().sort());
 assert.deepEqual(ids(await b.list(b.member, 'filter=stock')), [await b.threadOf('stock_item_id', item)]);
 assert.deepEqual(ids(await b.list(b.member, 'filter=bookings')), []);
 assert.equal((await b.list(b.member, 'filter=records')).threads.length, 5);
 for (const filter of ['files', 'people']) assert.deepEqual(await b.list(b.member, `filter=${filter}`), { filter, available: false, threads: [], nextCursor: null, groups: [] });
 assert.equal((await request('GET', `${b.threads}?filter=everything`, b.member)).status, 400);
 // Headings: one per tag a visible thread carries, plus Other, with counts over the whole set and the tag's owner and dates.
 const groups = Object.fromEntries(all.groups.map(g => [g.key, g]));
 // Every thread here carries the owner's change lines (its record's creation, its tags; 0047) or the owner's first message,
 // which are unread for the member: so every visible thread needs them, and the private one is never counted.
 assert.deepEqual(groups[production.id], { key: production.id, label: 'Production', threads: 2, needsYou: 2, owner: null, startsOn: null, endsOn: null },
  'the private thread is not counted for someone outside it');
 assert.deepEqual(groups[launch.id], { key: launch.id, label: 'Summer lager launch', threads: 2, needsYou: 2, owner: { id: b.member.user.id, name: `Mia ${people}` }, startsOn: '2031-06-01', endsOn: '2031-08-31' });
 assert.deepEqual(groups.none, { key: 'none', label: 'Other', threads: 5, needsYou: 5, owner: null, startsOn: null, endsOn: null });
 assert.equal((await b.list(b.owner)).groups.find(g => g.key === production.id)!.threads, 3, 'its participant sees it under the heading');
 // The headings are the same on every page, whatever the page size: they summarise the set, not the page.
 const firstPage = await b.list(b.member, 'limit=3');
 assert.deepEqual(firstPage.groups, all.groups);
 assert.deepEqual(firstPage.threads.map(t => t.id), all.threads.slice(0, 3).map(t => t.id));
 // A message on a thread already passed moves it to the top; paging on from the cursor neither repeats nor skips the rest.
 await b.send(b.owner, firstPage.threads[0]!.id, 'Bumped');
 const seen = [...firstPage.threads.map(t => t.id)];
 let cursor = firstPage.nextCursor;
 while (cursor) { const next: List = await b.list(b.member, `limit=3&after=${encodeURIComponent(cursor)}`); seen.push(...next.threads.map(t => t.id)); cursor = next.nextCursor; }
 assert.deepEqual(seen.slice().sort(), ids(all), 'every thread exactly once');
 assert.equal((await json<Failure>(request('GET', `${b.threads}?filter=tasks&after=${encodeURIComponent(firstPage.nextCursor!)}`, b.member), 400)).code, 'invalid_request',
  'a cursor belongs to its filter');
 // Newest activity first, then the threads with none.
 const ordered = (await b.list(b.member)).threads;
 assert.equal(ordered[0]!.id, firstPage.threads[0]!.id);
 const active = ordered.filter(t => t.lastMessageAt !== null);
 assert.deepEqual(ordered.slice(0, active.length), active);
});

it('a list has at most 100 headings, by thread count, and Other competes with the tags', async () => {
 const b = await business('Many tags');
 const tags = await fixture(db.owner, b.org)<{ id: string }[]>`insert into tags (organisation_id, name) select ${b.org}, 'Tag ' || lpad(g::text, 3, '0') from generate_series(1, 101) g returning id`;
 const task = await b.task('Tagged a lot'), busy = await b.task('Tagged twice');
 const [thread, busyThread] = [await b.threadOf('task_id', task), await b.threadOf('task_id', busy)];
 await fixture(db.owner, b.org)`insert into thread_tags (organisation_id, thread_id, tag_id) select ${b.org}, ${thread}, id from tags where organisation_id = ${b.org}`;
 await fixture(db.owner, b.org)`insert into thread_tags (organisation_id, thread_id, tag_id) values (${b.org}, ${busyThread}, ${tags[100]!.id})`;
 await b.task('Untagged');
 const groups = (await b.list(b.member)).groups;
 assert.equal(groups.length, groupLimit);
 // needsYou 2: the owner's creation lines and the system's tag lines (0047) are unread for the member.
 assert.deepEqual(groups[0], { key: tags[100]!.id, label: 'Tag 101', threads: 2, needsYou: 2, owner: null, startsOn: null, endsOn: null }, 'the largest first');
 assert.deepEqual(groups.slice(1).map(g => g.threads), Array(99).fill(1));
 assert.ok(groups.some(g => g.key === 'none'), 'Other is a heading when untagged threads exist');
 assert.ok(!groups.some(g => g.label === 'Tag 100'), 'the rest are cut, by count then name');
});

it('needs you: unread messages, or an open task or booking the caller owns; read positions start at 0 on record and topic threads', async () => {
 const b = await business('Needs you');
 const mine = await b.task('Mine', { ownerId: b.member.user.id }), theirs = await b.task('Theirs', { ownerId: b.other.user.id });
 const done = await b.task('Done already', { ownerId: b.member.user.id, status: 'done' });
 const [mineThread, theirsThread, doneThread] = [await b.threadOf('task_id', mine), await b.threadOf('task_id', theirs), await b.threadOf('task_id', done)];
 const tank = (await json<{ id: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Kettle' }), 201)).id;
 const booking = (await json<{ id: string }>(request('POST', `${b.base}/equipment/${tank}/reservations`, b.owner,
  { id: randomUUID(), title: 'Boil', startsAt: '2031-07-01T08:00:00Z', endsAt: '2031-07-01T10:00:00Z', ownerId: b.member.user.id }), 201)).id;
 const bookingThread = await b.threadOf('reservation_id', booking);
 const row = async (id: string, person = b.member) => (await b.list(person)).threads.find(t => t.id === id)!;
 // Each creation is the owner's change line (0047): unread for the member, so every one of these needs them until read.
 assert.deepEqual([(await row(theirsThread)).unread, (await row(theirsThread)).needsYou], [1, true], 'another person’s change line is unread');
 assert.equal((await row(theirsThread, b.owner)).unread, 0, 'the actor’s own change line is not');
 for (const thread of [mineThread, theirsThread, doneThread, bookingThread]) await json(request('POST', `${b.threads}/${thread}/read`, b.member, { seq: 1 }));
 assert.equal((await row(mineThread)).needsYou, true, 'an open task I own');
 assert.equal((await row(bookingThread)).needsYou, true, 'an upcoming booking I own');
 assert.equal((await row(theirsThread)).needsYou, false);
 assert.equal((await row(doneThread)).needsYou, false, 'done is not waiting on me');
 await b.send(b.owner, theirsThread, 'Can you look at this?');
 await b.send(b.member, doneThread, 'My own words are never unread');
 const theirsRow = await row(theirsThread);
 assert.deepEqual([theirsRow.unread, theirsRow.needsYou], [1, true], 'the new message is unread');
 assert.deepEqual([(await row(doneThread)).unread, (await row(doneThread)).needsYou], [0, false]);
 assert.deepEqual((await b.list(b.member, 'filter=needs_you')).threads.map(t => t.id).sort(), [mineThread, theirsThread, bookingThread].sort());
 assert.equal((await b.list(b.member)).groups.find(g => g.key === 'none')!.needsYou, 3);
 assert.deepEqual(await json(request('POST', `${b.threads}/${theirsThread}/read`, b.member, { seq: 2 })), { readPosition: 2, unread: 0 });
 assert.equal((await row(theirsThread)).needsYou, false);
 assert.equal((await b.detail(b.other, theirsThread)).thread.readPosition, 0, 'a read position is personal');
});

it('unread counts a run of change lines as one, splits runs at messages, skips the caller’s own lines and the system’s creation lines, and agrees everywhere', async () => {
 const b = await business('Change runs');
 const revisionOf = async (task: string) => (await json<{ task: { revision: number } }>(request('GET', `${b.base}/tasks/${task}?limit=50`, b.owner))).task.revision;
 const retitle = async (person: Person, task: string, title: string) =>
  json(request('PATCH', `${b.base}/tasks/${task}`, person, { changeSetId: randomUUID(), expectedRevision: await revisionOf(task), title }));
 const read = (person: Person, thread: string, seq: number) => json<{ readPosition: number; unread: number }>(request('POST', `${b.threads}/${thread}/read`, person, { seq }));
 // Every surface answers the same number: the detail, the list row, and the read endpoint at the current position.
 const counts = async (person: Person, thread: string) => {
  const detail = (await b.detail(person, thread)).thread, row = (await b.list(person)).threads.find(t => t.id === thread)!;
  const answered = await read(person, thread, Math.max(detail.readPosition, 1));
  assert.deepEqual([row.unread, answered.unread], [detail.unread, detail.unread], 'the list row, the detail and the read answer agree');
  return detail.unread;
 };
 const task = await b.task('Pack the lager'), thread = await b.threadOf('task_id', task);
 assert.equal((await b.detail(b.member, thread)).thread.unread, 1, 'the owner’s creation line alone is one run');
 await read(b.member, thread, 1);
 // One message by another, then three consecutive change lines by others: 2.
 await b.send(b.owner, thread, 'Pack it Friday');
 await retitle(b.owner, task, 'Pack the summer lager');
 await retitle(b.admin, task, 'Pack the summer lager, 24 cases');
 await retitle(b.owner, task, 'Pack the summer lager, 30 cases');
 assert.equal(await counts(b.member, thread), 2, 'a message and one run of three lines');
 // A message by another splits the next lines into their own run: 2 + 1 message + 1 run = 4.
 await b.send(b.admin, thread, 'Labels are in');
 await retitle(b.owner, task, 'Pack 30 cases');
 assert.equal(await counts(b.member, thread), 4, 'two runs split by a message, and two messages');
 // The caller's own lines count 0, and their own message still ends a run.
 await b.send(b.member, thread, 'On it');
 await retitle(b.member, task, 'Pack 30 cases Friday');
 await retitle(b.member, task, 'Pack 30 cases, Friday');
 assert.equal(await counts(b.member, thread), 4, 'my own message and lines add nothing');
 await retitle(b.owner, task, 'Pack 30 cases on Friday');
 assert.equal(await counts(b.member, thread), 5, 'a run with one line by another is one, whoever else is in it');
 const lines = (await json<{ messages: { seq: number; kind: string }[] }>(request('GET', `${b.threads}/${thread}/messages?latest=50`, b.member))).messages;
 assert.deepEqual(lines.map(m => m.kind), ['change', 'message', 'change', 'change', 'change', 'message', 'change', 'message', 'change', 'change', 'change']);
 // For the owner (never read): the run with the admin's line, the admin's message, the member's message and the member's run.
 assert.equal((await b.detail(b.owner, thread)).thread.unread, 4);
 // The read position starts a run: reading into the middle of one leaves its rest as one.
 assert.deepEqual(await read(b.member, thread, 4), { readPosition: 4, unread: 4 }, 'the rest of the first run, a message, a run, and the last run');
 assert.deepEqual(await read(b.member, thread, 11), { readPosition: 11, unread: 0 });

 // The system's creation of a series occurrence, with its series' tags: quiet. A later message by another is 1.
 const tag = await b.tag('Compliance');
 const series = await json<{ id: string }>(request('POST', `${b.base}/series`, b.owner, { title: 'Excise return', recurrence: 'monthly', anchor: '2026-01-01', tagIds: [tag.id] }), 201);
 assert.equal(await new CommitmentsService(db.app).materialise(b.org, '2099-03-15'), 1);
 const [occurrence] = await db.owner<{ id: string }[]>`select th.id from tasks t join threads th on th.task_id = t.id where t.series_id = ${series.id} and t.period_start = '2099-03-01'`;
 const quiet = occurrence!.id;
 const quietLines = await db.owner<{ actorKind: string; operations: string[] }[]>`select c.actor_kind, array_agg(rc.operation order by rc.id) as operations from thread_messages m
  join change_sets c on c.id = m.change_set_id join record_changes rc on rc.change_set_id = c.id where m.thread_id = ${quiet} group by c.actor_kind`;
 assert.deepEqual([...quietLines], [{ actorKind: 'system', operations: ['create', 'attach'] }], 'the system created it with its tag, in one change set');
 // The Expo client reads the same real lines: it folds the runs the server counts, and finds the creation line quiet.
 const { parseMessages } = await import('../../../mobile/src/threads/parse.ts');
 const { displayItems } = await import('../../../mobile/src/threads/runs.ts');
 const { quietLine, firstUnread } = await import('../../../mobile/src/threads/derive.ts');
 const parsed = parseMessages(await json(request('GET', `${b.threads}/${thread}/messages?latest=50`, b.member))).messages;
 assert.deepEqual(displayItems(parsed).map(i => i.kind === 'foldedRun' ? `run:${i.lines.map(l => l.seq).join(',')}:${i.actors.join('+')}` : `${i.kind}:${i.message.seq}`),
  ['changeLine:1', 'message:2', 'run:3,4,5:Olive+Ada', 'message:6', 'changeLine:7', 'message:8', 'run:9,10,11:Mia+Olive']);
 const quietPage = parseMessages(await json(request('GET', `${b.threads}/${quiet}/messages?latest=50`, b.member))).messages;
 assert.deepEqual([quietPage.length, quietLine(quietPage[0]!), firstUnread(quietPage, 0, b.member.user.id)], [1, true, null]);
 assert.equal((await b.detail(b.member, quiet)).thread.unread, 0, 'a system creation line alone is not unread');
 assert.equal((await b.list(b.member)).threads.find(t => t.id === quiet)!.unread, 0);
 assert.equal((await b.list(b.member, 'filter=needs_you')).threads.some(t => t.id === quiet), false, 'nor does it need you');
 assert.ok((await b.list(b.member)).threads.find(t => t.id === quiet)!.lastMessageAt, 'it still moves the thread’s activity time');
 await b.send(b.owner, quiet, 'Filed early this time');
 assert.equal(await counts(b.member, quiet), 1, 'with a later message by another: 1');
 // A system change that is not a creation counts as a person's would: a tag the system attaches later.
 const later = await b.tag('Later');
 await fixture(db.owner, b.org)`insert into thread_tags (organisation_id, thread_id, tag_id) values (${b.org}, ${quiet}, ${later.id})`;
 assert.equal(await counts(b.member, quiet), 2, 'the system’s tag line is unread activity');
 // The system creating a task with no series and no tags is quiet too; a person's creation is not.
 const [made] = await fixture(db.owner, b.org)<{ id: string }[]>`insert into tasks (organisation_id, title) values (${b.org}, 'Made by the system') returning id`;
 assert.equal((await b.detail(b.member, await b.threadOf('task_id', made!.id))).thread.unread, 0);
});

it('unread runs stop at the cap of 51', async () => {
 const b = await business('Run cap');
 const task = await b.task('Busy'), thread = await b.threadOf('task_id', task);
 // The creation line, then 26 times a message and a change line by another: 53 units, capped.
 let revision = (await json<{ task: { revision: number } }>(request('GET', `${b.base}/tasks/${task}?limit=50`, b.owner))).task.revision;
 for (let i = 0; i < 26; i++) {
  await b.send(b.owner, thread, `Note ${i}`);
  await json(request('PATCH', `${b.base}/tasks/${task}`, b.owner, { changeSetId: randomUUID(), expectedRevision: revision++, title: `Busy ${i}` }));
 }
 assert.equal((await b.detail(b.member, thread)).thread.unread, 51);
 assert.equal((await b.list(b.member)).threads.find(t => t.id === thread)!.unread, 51);
 assert.deepEqual(await json(request('POST', `${b.threads}/${thread}/read`, b.member, { seq: 3 })), { readPosition: 3, unread: 50 });
});

it('the latest live message is excerpted at 120 characters with its author; a tombstone is skipped', async () => {
 const b = await business('Excerpts');
 const thread = (await json<Detail>(b.topic(b.member, 'First words'), 201)).thread.id;
 assert.deepEqual((await b.list(b.owner)).threads[0]!.lastMessage, { authorName: `Mia ${people}`, excerpt: 'First words' });
 const long = await b.send(b.owner, thread, '🍺'.repeat(4000));
 assert.deepEqual((await b.list(b.owner)).threads[0]!.lastMessage, { authorName: `Olive ${people}`, excerpt: '🍺'.repeat(120) });
 await json(request('DELETE', `${b.threads}/${thread}/messages/${long.id}?expectedRevision=1`, b.owner));
 assert.deepEqual((await b.list(b.owner)).threads[0]!.lastMessage, { authorName: `Mia ${people}`, excerpt: 'First words' }, 'the latest live message');
});

it('tags are added and removed on any thread with the thread’s revision, audited as thread writes, and archived tags stay attached', async () => {
 const b = await business('Thread tags');
 const tag = await b.tag('Wholesale');
 const task = await b.task('Price list');
 const thread = await b.threadOf('task_id', task);
 assert.equal((await json<Failure>(b.addTag(b.member, thread, tag.id, 2), 409)).code, 'stale_revision');
 const added = await json<Detail>(b.addTag(b.member, thread, tag.id, 1));
 assert.deepEqual([added.thread.revision, added.tags], [2, [{ id: tag.id, name: 'Wholesale' }]]);
 assert.deepEqual((await json<Detail>(b.addTag(b.member, thread, tag.id, 2))).thread.revision, 2, 'adding it again changes nothing');
 const task2 = (await json<{ tags: { items: Chip[] } }>(request('GET', `${b.base}/tasks/${task}`, b.member))).tags.items;
 assert.deepEqual(task2, [{ id: tag.id, name: 'Wholesale' }], 'a task’s tags are read through its thread');
 assert.deepEqual((await json<{ tasks: { id: string }[] }>(request('GET', `${b.base}/tasks?tagId=${tag.id}`, b.member))).tasks.map(t => t.id), [task]);
 // Audit: a thread write, in chat audit; the tenant-wide log has the tag's own creation only.
 assert.deepEqual((await db.owner<{ action: string }[]>`select action from chat_audit_events where thread_id = ${thread}`).map(r => r.action), ['chat.tag_added']);
 assert.equal((await db.owner`select 1 from audit_events where organisation_id = ${b.org} and detail::text like ${`%${thread}%`}`).length, 0);
 // Archiving keeps the attachment; an archived tag is not newly added.
 await json(request('PATCH', `${b.base}/tags/${tag.id}`, b.owner, { expectedRevision: tag.revision, archived: true }));
 assert.deepEqual((await b.detail(b.member, thread)).tags.map(t => t.id), [tag.id]);
 const topic = (await json<Detail>(b.topic(b.member, 'Archived tag'), 201)).thread.id;
 assert.equal((await json<Failure>(b.addTag(b.member, topic, tag.id, 1), 409)).code, 'tag_archived');
 const removed = await json<Detail>(b.removeTag(b.other, thread, tag.id, 2));
 assert.deepEqual([removed.thread.revision, removed.tags], [3, []]);
 assert.equal((await b.addTag(b.member, thread, randomUUID(), 3)).status, 404, 'an unknown tag');
 // A private thread: only its participants tag it, and the tag's own listing shows nothing of it.
 const secret = (await json<Detail>(request('POST', b.threads, b.member, { id: randomUUID(), kind: 'private', title: 'Pricing', participantIds: [] }), 201)).thread.id;
 const open = await b.tag('Open tag');
 assert.equal((await b.addTag(b.other, secret, open.id, 1)).status, 404);
 await json(b.addTag(b.member, secret, open.id, 1));
 const listing = await json<{ tags: Record<string, unknown>[] }>(request('GET', `${b.base}/tags`, b.other));
 assert.ok(!JSON.stringify(listing).includes(secret));
 assert.ok(listing.tags.every(t => Object.keys(t).sort().join() === 'archivedAt,createdAt,createdBy,endsOn,id,name,ownerId,revision,startsOn,updatedAt'), 'no count of threads');
});

it('pins on record and topic threads are an owner’s or admin’s, one at a time, and the detail carries it', async () => {
 const b = await business('Shared pins');
 const topic = (await json<Detail>(b.topic(b.member, 'Brew day rota'), 201)).thread.id;
 const said = await b.send(b.other, topic, 'I take Mondays');
 assert.equal((await request('POST', `${b.threads}/${topic}/pin`, b.member, { messageId: said.id })).status, 403);
 const pin = await json<{ id: string }>(request('POST', `${b.threads}/${topic}/pin`, b.admin, { messageId: said.id }), 201);
 assert.equal((await b.detail(b.other, topic)).pin!.id, pin.id, 'everyone who sees the thread sees its pin');
 const second = await b.send(b.owner, topic, 'Tuesdays are mine');
 assert.equal((await json<Failure>(request('POST', `${b.threads}/${topic}/pin`, b.owner, { messageId: second.id }), 409)).code, 'pin_exists');
 await json(request('DELETE', `${b.threads}/${topic}/pin`, b.owner));
 assert.equal((await b.detail(b.other, topic)).pin, null);
});

it('access: a removed member sees 404; a non-participant sees nothing of a private thread, by any path', async () => {
 const b = await business('Access');
 const task = await b.task('Supplier contract');
 const record = await b.threadOf('task_id', task);
 await b.send(b.member, record, 'Draft is in');
 const secret = (await json<Detail>(request('POST', b.threads, b.owner, { id: randomUUID(), kind: 'private', title: 'Pricing', participantIds: [b.admin.user.id],
  message: { id: randomUUID(), body: 'Margins are thin' } }), 201)).thread.id;
 const tag = await b.tag('Contracts');
 await json(b.addTag(b.owner, secret, tag.id, 1));
 const said = (await json<{ messages: Message[] }>(request('GET', `${b.threads}/${secret}/messages?latest=5`, b.owner))).messages.find(m => m.kind === 'message')!;
 // The tag's change line is in the private thread; it cannot be pinned, edited or deleted (0047).
 const line = (await json<{ messages: Message[] }>(request('GET', `${b.threads}/${secret}/messages?latest=5`, b.owner))).messages.find(m => m.kind === 'change')!;
 assert.equal((await json<Failure>(request('POST', `${b.threads}/${secret}/pin`, b.owner, { messageId: line.id }), 409)).code, 'change_line_immutable');
 await json(request('POST', `${b.threads}/${secret}/pin`, b.owner, { messageId: said.id }), 201);
 // Rows and detail carry no links: R2 has no way to write one.
 assert.ok(!('links' in (await b.detail(b.admin, secret))) && !('links' in (await b.list(b.admin)).threads.find(t => t.id === secret)!));
 // The member: the record thread is theirs to see, the private thread is not, by any path.
 assert.equal((await b.detail(b.member, record)).thread.lastSeq, 2, 'the task’s creation line and the message');
 for (const path of ['', '/messages?latest=5', '/changes?after=0']) assert.equal((await request('GET', `${b.threads}/${secret}${path}`, b.member)).status, 404, path || 'detail');
 for (const response of [request('POST', `${b.threads}/${secret}/pin`, b.owner.user.id === b.member.user.id ? b.owner : b.member, { messageId: said.id }),
  b.addTag(b.member, secret, tag.id, 2), request('POST', `${b.threads}/${secret}/star`, b.member)]) assert.equal((await response).status, 404);
 const taskDetail = await json<Record<string, unknown>>(request('GET', `${b.base}/tasks/${task}`, b.member));
 assert.ok(!JSON.stringify(taskDetail).includes(secret), 'nor does the record’s own screen');
 assert.ok(!JSON.stringify(await b.list(b.member, 'filter=tasks')).includes(secret));
 const asMember = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant<T>(db.app, { organisationId: b.org, userId: b.member.user.id }, work);
 for (const table of ['thread_tags', 'thread_pins', 'thread_messages', 'chat_audit_events'])
  assert.equal((await asMember(tx => tx.unsafe(`select 1 from ${table} where thread_id = $1`, [secret]))).length, 0, table);
 // A removed member sees nothing at all, record threads included.
 await json(request('DELETE', `${b.base}/members/${b.member.user.id}`, b.owner));
 assert.equal((await request('GET', `${b.threads}/${record}`, b.member)).status, 404);
 assert.equal((await request('GET', b.threads, b.member)).status, 404);
 assert.equal((await request('POST', `${b.threads}/${record}/messages`, b.member, { id: randomUUID(), body: 'Still here?' })).status, 404);
});

it('the Expo client parses real list, card, message, pin and change payloads for every R2 thread kind', async () => {
 const { parseList, parseDetail, parseMessage, parseMessages, parseChanges, parseChangedPin, parseRead, parseStar } = await import('../../../mobile/src/threads/parse.ts');
 const b = await business('Expo wire contract');
 const task = await b.task('Packaging', { body: 'Pack the cans', ownerId: b.member.user.id, due: '2031-05-01' });
 const tank = (await json<{ id: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Tank' }), 201)).id;
 await json(request('POST', `${b.base}/equipment/${tank}/reservations`, b.owner,
  { id: randomUUID(), title: 'Clean tank', kind: 'maintenance', startsAt: '2031-05-01T08:00:00Z', endsAt: '2031-05-01T09:00:00Z' }), 201);
 await json(request('POST', `${b.base}/stock`, b.owner, { name: 'Cans', location: 'Store', unitLabel: 'each', notes: 'Keep dry' }), 201);
 const topic = parseDetail(await json(b.topic(b.member, 'Plan the packaging run'), 201));
 const privateThread = parseDetail(await json(request('POST', b.threads, b.member,
  { id: randomUUID(), kind: 'private', title: 'Costs', participantIds: [b.owner.user.id], message: { id: randomUUID(), body: 'Check privately' } }), 201));
 const tag = await b.tag('Launch', { ownerId: b.member.user.id, startsOn: '2031-05-01', endsOn: '2031-05-02' });
 parseDetail(await json(b.addTag(b.member, topic.thread.id, tag.id, 1)));
 const list = parseList(await json(request('GET', `${b.threads}?filter=all&limit=50`, b.member)));
 assert.equal(list.threads.length, 5);
 assert.deepEqual(new Set(list.threads.map(row => row.record?.kind ?? row.kind)), new Set(['task', 'booking', 'stock', 'topic', 'private']));
 assert.equal(list.groups.find(group => group.key === tag.id)?.owner?.id, b.member.user.id);
 for (const row of list.threads) {
  const detail = parseDetail(await json(request('GET', `${b.threads}/${row.id}`, b.member)));
  assert.equal(detail.thread.id, row.id);
 }
 const thread = `${b.threads}/${topic.thread.id}`;
 const sent = parseMessage(await json(request('POST', `${thread}/messages`, b.member, { id: randomUUID(), body: 'Ready' }), 201));
 const edited = parseMessage(await json(request('PATCH', `${thread}/messages/${sent.id}`, b.member, { body: 'Ready now', expectedRevision: sent.revision })));
 const pin = parseChangedPin(await json(request('POST', `${thread}/pin`, b.owner, { messageId: sent.id }), 201));
 assert.equal(parseDetail(await json(request('GET', thread, b.member))).pin?.id, pin.id);
 parseChangedPin(await json(request('DELETE', `${thread}/pin`, b.owner)));
 // 0047 puts change lines (kind 'change', no body, with changeSetId and change) in a thread: the topic's tag made one.
 // V-D's parser reads them strictly, in a page of messages and in the change feed, beside plain messages.
 const lined = parseMessages(await json(request('GET', `${thread}/messages?latest=50`, b.member)));
 const tagLine = lined.messages.find(m => m.kind === 'change');
 assert.ok(tagLine?.change && tagLine.changeSetId);
 assert.deepEqual(tagLine.change.changes.map(c => [c.recordKind, c.operation, c.itemKind, c.itemId]), [['thread', 'attach', 'tag', tag.id]]);
 assert.ok(parseChanges(await json(request('GET', `${thread}/changes?after=0&limit=100`, b.member))).changes.some(c => c.kind === 'message' && c.message.kind === 'change'));
 const plain = `${b.threads}/${privateThread.thread.id}`;
 parseMessages(await json(request('GET', `${plain}/messages?latest=50`, b.member)));
 parseChanges(await json(request('GET', `${plain}/changes?after=0&limit=100`, b.member)));
 parseRead(await json(request('POST', `${thread}/read`, b.member, { seq: sent.seq })));
 parseStar(await json(request('POST', `${thread}/star`, b.member)));
 const deleted = parseMessage(await json(request('DELETE', `${thread}/messages/${sent.id}?expectedRevision=${edited.revision}`, b.member)));
 assert.equal(deleted.body, null);
 assert.equal((await request('GET', `${b.threads}/${privateThread.thread.id}`, b.other)).status, 404);
 assert.equal(parseList(await json(request('GET', `${b.threads}?filter=all`, b.other))).threads.some(row => row.id === privateThread.thread.id), false);
 assert.ok(task);
});

it('the Expo create controller reconciles an uncertain private create against the real API and parses picker choices', async () => {
 const { createNewStorage, createNewThread } = await import('../../../mobile/src/threads/create.ts');
 const { createThreadCalls } = await import('../../../mobile/src/threads/api.ts');
 const { parseTagPage } = await import('../../../mobile/src/threads/options.ts');
 const { parseMembers } = await import('../../../mobile/src/account/members.ts');
 const b = await business('Expo creation');
 await b.tag('Production', { ownerId: b.owner.user.id, startsOn: '2031-05-01' });
 assert.equal(parseTagPage(await json(request('GET', `${b.base}/tags?offset=0&limit=50`, b.member))).tags.length, 1);
 assert.equal(parseMembers(await json(request('GET', `${b.base}/members`, b.member))).length, 4);
 const scope = { userId: b.member.user.id, organisationId: b.org, epoch: 'test' };
 let loseResponse = true;
 const bodies: unknown[] = [];
 const client: import('../../../mobile/src/auth/contracts.ts').ApiClient = {
  async get(path, _token, parse) { return { ok: true, value: parse(await json(request('GET', path, b.member))) }; },
  async post(path, _token, body, parse) {
   bodies.push(body);
   const response = await request('POST', path, b.member, body);
   assert.equal(response.status, loseResponse ? 201 : 200);
   const value = await response.json();
   if (loseResponse) { loseResponse = false; return { ok: false, kind: 'unavailable', status: 503 }; }
   return { ok: true, value: parse(value) };
  },
  async patch() { throw new Error('unexpected patch'); }, async delete() { throw new Error('unexpected delete'); },
 };
 const calls = createThreadCalls(client, { scope: () => scope, sessionEnded() {}, reconcile() {} });
 const values = new Map<string, string>();
 const storage = createNewStorage(() => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
  removeItem: key => { values.delete(key); }, key: index => [...values.keys()][index] ?? null, get length() { return values.size; } }));
 const opened: string[] = [];
 const first = createNewThread(calls, scope, storage, Date.now, randomUUID, id => opened.push(id));
 first.edit({ private: true, title: 'Supplier costs', body: 'Review these privately', participantIds: [b.owner.user.id] });
 await first.send();
 assert.equal(first.snapshot().draft.locked, true); assert.equal(opened.length, 0); first.dispose();
 const retried = createNewThread(calls, scope, storage, Date.now, randomUUID, id => opened.push(id));
 await retried.send();
 assert.deepEqual(bodies[1], bodies[0]); assert.equal(opened.length, 1); assert.equal(values.size, 0);
 const page = await json<{ messages: Message[] }>(request('GET', `${b.threads}/${opened[0]}/messages?latest=50`, b.member));
 assert.equal(page.messages.length, 1); assert.equal(page.messages[0]?.body, 'Review these privately');
 assert.equal((await request('GET', `${b.threads}/${opened[0]}`, b.other)).status, 404);
});

it('real change lines for a task edit, a step, a tag, a booking move and a stock count parse in the Expo client and are worded; its card parsers read the real writes', async () => {
 const { parseMessages, parseChanges } = await import('../../../mobile/src/threads/parse.ts');
 const { wordChangeLine, wordedFields } = await import('../../../mobile/src/threads/wording.ts');
 const { parseTaskDetail, parseTaskWrite, parseBooking, parseCount } = await import('../../../mobile/src/threads/cards/records.ts');
 // The client words every field the database journals (it mirrors the list; this is the authority).
 const camel = (f: string) => f.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
 assert.deepEqual(Object.fromEntries(Object.entries(wordedFields).map(([t, f]) => [t, [...f].sort()])),
  Object.fromEntries(Object.entries(journalFields).map(([t, f]) => [t, f.map(camel).sort()])));
 const b = await business('Expo change lines');
 const n = people, owner = `Olive ${n}`, member = `Mia ${n}`;
 const names = { person: (id: string) => id === b.member.user.id ? member : id === b.owner.user.id ? owner : null };
 const lines = async (thread: string) => {
  const page = parseMessages(await json(request('GET', `${b.threads}/${thread}/messages?latest=50`, b.member)));
  parseChanges(await json(request('GET', `${b.threads}/${thread}/changes?after=0&limit=100`, b.member)));
  return page.messages.filter(m => m.kind === 'change');
 };
 const say = (m: { change?: Parameters<typeof wordChangeLine>[0] }, extra: Parameters<typeof wordChangeLine>[1] = {}) => wordChangeLine(m.change!, { names, year: 2031, zone: 'UTC', ...extra }).text;

 // A task: created, then title, owner and due together as one change set with the client's id.
 const task = await b.task('Pack', { due: '2031-10-06' });
 const thread = await b.threadOf('task_id', task);
 const detail = parseTaskDetail(await json(request('GET', `${b.base}/tasks/${task}?limit=50`, b.member)), task);
 const edit = randomUUID();
 const edited = parseTaskWrite(await json(request('PATCH', `${b.base}/tasks/${task}`, b.member, { changeSetId: edit, expectedRevision: detail.task.revision, title: 'Package summer lager', ownerId: b.member.user.id, due: '2031-10-08' })), { id: task, changeSetId: edit });
 assert.equal(edited.revision, detail.task.revision + 1);
 // A step: added, then ticked as its own change set.
 const add = randomUUID();
 const step = parseTaskWrite(await json(request('POST', `${b.base}/tasks`, b.member, { changeSetId: add, parentId: task, expectedParentRevision: edited.revision, title: 'Book the canning line' }), 201), { parentId: task, changeSetId: add });
 const tick = randomUUID();
 parseTaskWrite(await json(request('PATCH', `${b.base}/tasks/${step.id}`, b.member, { changeSetId: tick, expectedRevision: step.revision, status: 'done' })), { id: step.id, changeSetId: tick });
 // A tag on the task's thread.
 const tag = await b.tag('Production');
 await tagged(b, thread, tag.id);
 const taskLines = await lines(thread);
 const steps = parseTaskDetail(await json(request('GET', `${b.base}/tasks/${task}?limit=50`, b.member)), task).steps;
 const stepNames = { ...names, step: (id: string) => steps.find(s => s.id === id)?.title ?? null, tag: (id: string) => id === tag.id ? 'Production' : null };
 assert.deepEqual(taskLines.map(m => say(m, { names: stepNames })), [
  `Olive created the task Pack`,
  `Mia changed the title from Pack to Package summer lager, set the owner to ${member} and changed the due date from Mon 6 Oct to Wed 8 Oct`,
  'Mia added the step Book the canning line',
  'Mia ticked the step Book the canning line',
  'Olive added the tag Production'
 ]);
 assert.deepEqual(taskLines.slice(1, 4).map(m => m.changeSetId), [edit, add, tick], 'each line names the client’s change set');

 // A booking moved: start, end and setup in one phrase.
 const tank = (await json<{ id: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Canning line' }), 201)).id;
 const made = await json<{ id: string }>(request('POST', `${b.base}/equipment/${tank}/reservations`, b.owner,
  { id: randomUUID(), title: 'Summer lager canning run', startsAt: '2031-10-08T08:00:00Z', endsAt: '2031-10-08T12:00:00Z' }), 201);
 const booking = parseBooking(await json(request('GET', `${b.base}/equipment/${tank}/reservations/${made.id}`, b.member)), { id: made.id, equipmentId: tank });
 const move = randomUUID();
 const moved = parseBooking(await json(request('PATCH', `${b.base}/equipment/${tank}/reservations/${made.id}`, b.member, { changeSetId: move, expectedRevision: booking.revision,
  title: booking.title, kind: booking.kind, startsAt: '2031-10-08T09:00:00.000Z', endsAt: '2031-10-08T13:00:00.000Z', setupMinutes: 30, cleanupMinutes: 0, taskId: null, ownerId: null })), { id: made.id, equipmentId: tank, changeSetId: move });
 const cancel = randomUUID();
 parseBooking(await json(request('POST', `${b.base}/equipment/${tank}/reservations/${made.id}/cancel`, b.member, { changeSetId: cancel, expectedRevision: moved.revision })), { id: made.id, equipmentId: tank, changeSetId: cancel });
 const bookingLines = await lines(await b.threadOf('reservation_id', made.id));
 assert.deepEqual(bookingLines.map(m => say(m)), ['Olive booked Summer lager canning run',
  'Mia changed the time from Wed 8 Oct, 8:00 am–12:00 pm to Wed 8 Oct, 9:00 am–1:00 pm and setup from none to 30 minutes', 'Mia cancelled the booking']);

 // A stock count, with the unit.
 const item = (await json<{ id: string }>(request('POST', `${b.base}/stock`, b.owner, { name: 'Hops', location: 'Store', unitLabel: 'kg' }), 201)).id;
 const counted = randomUUID();
 assert.equal(parseCount(await json(request('POST', `${b.base}/stock/${item}/count`, b.member, { changeSetId: counted, count: '4.5', note: 'Back shelf' }), 201), { itemId: item, changeSetId: counted }).count, '4.5');
 const stockLines = await lines(await b.threadOf('stock_item_id', item));
 assert.deepEqual(stockLines.map(m => say(m, { unit: 'kg' })), ['Olive created the stock item Hops', 'Mia counted 4.5 kg']);
});

it('real history pages, a version, previews (a conflict, a blocked booking), a stale apply, an apply and topic to task parse in the Expo client and drive its History controller', async () => {
 const { parseHistory, parseVersion, parsePreview, parseStale } = await import('../../../mobile/src/threads/history/parse.ts');
 const { entrySentence, plainText, stateWords, conflictWords, blockedReason, versionLines } = await import('../../../mobile/src/threads/history/words.ts');
 const { createHistory, entryIndex } = await import('../../../mobile/src/threads/history/controller.ts');
 const { createPendingUndoStorage } = await import('../../../mobile/src/threads/history/storage.ts');
 const { makeTaskBody, parseMadeTask } = await import('../../../mobile/src/threads/cards/make-task.ts');
 const { parseMessages } = await import('../../../mobile/src/threads/parse.ts');
 const { wordDate } = await import('../../../mobile/src/threads/wording.ts');
 const { apiOutcome } = await import('../../../mobile/src/api/failure.ts');
 const { createThreadCalls } = await import('../../../mobile/src/threads/api.ts');
 type Outcome<T> = import('../../../mobile/src/auth/contracts.ts').ApiOutcome<T>;
 const b = await business('Expo history');
 const n = people, words = { now: Date.now(), zone: 'UTC' };
 // The client's own mapping of a real answer (status and body), so refusals keep their detail as they do in the app.
 const answer = async <T>(person: Person, method: string, path: string, body: unknown, parse: (v: unknown) => T): Promise<Outcome<T>> => {
  const response = await request(method, path, person, body);
  return apiOutcome({ kind: 'answered', status: response.status, body: { readable: true, value: await response.json() } }, parse);
 };
 const date = (d: string) => wordDate(d, new Date(words.now).getFullYear());

 // A task: made, its due date moved twice, a tag, an owner.
 const task = await b.task('Package summer lager', { due: '2031-10-02' });
 const thread = await b.threadOf('task_id', task);
 const edit = (person: Person, body: Record<string, unknown>) => json<{ revision: number; changeSetId: string }>(request('PATCH', `${b.base}/tasks/${task}`, person, body));
 const first = await edit(b.owner, { expectedRevision: 1, due: '2031-10-06' });
 const second = await edit(b.owner, { expectedRevision: 2, due: '2031-10-08' });
 const tag = await b.tag('Production');
 await tagged(b, thread, tag.id);
 const owned = await edit(b.member, { expectedRevision: 3, ownerId: b.member.user.id });

 // Pages of two, newest first, to the start of history: every page parses.
 const target = { kind: 'task' as const, id: task };
 const pages: ReturnType<typeof parseHistory>[] = [];
 let cursor: string | null = null;
 do {
  const raw: unknown = await json(request('GET', `${b.base}/history/task/${task}?limit=2${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`, b.member));
  const page = parseHistory(raw, target); pages.push(page); cursor = page.nextCursor;
 } while (cursor);
 const sets = pages.flatMap(p => p.changeSets), names = { people: Object.assign({}, ...pages.map(p => p.names.people)), tags: Object.assign({}, ...pages.map(p => p.names.tags)) };
 assert.deepEqual([pages.length, sets.length, pages.at(-1)!.start?.kind], [3, 5, 'created']);
 const of = (changeSetId: string) => sets.find(s => s.id === changeSetId)!;
 const due1 = of(first.changeSetId).changes[0]!, due2 = of(second.changeSetId).changes[0]!;
 assert.equal(plainText(entrySentence(due1, of(first.changeSetId), names, words)), `Changed the due date from ${date('2031-10-02')} to ${date('2031-10-06')}`);
 assert.equal(due1.state, 'conflict');
 assert.match(conflictWords(due1 as typeof due1 & { state: 'conflict' }, names, words).also, new RegExp(`^Also undo the change of (today|\\w{3} \\d{1,2} \\w{3}( \\d{4})?)\\. The due date goes back to ${date('2031-10-02')}\\.$`));
 const created = sets.at(-1)!.changes[0]!;
 assert.deepEqual([created.operation, stateWords(created, words)], ['create', { badge: 'Can’t undo', note: 'Cancel or complete it instead.', tickable: false }]);
 const attach = sets.flatMap(s => s.changes).find(c => c.itemKind === 'tag')!;
 assert.equal(plainText(entrySentence(attach, sets.find(s => s.changes.includes(attach))!, names, words)), 'Added the tag Production');
 assert.match(plainText(entrySentence(of(owned.changeSetId).changes[0]!, of(owned.changeSetId), names, words)), new RegExp(`the owner .*Mia ${n}$`));
 // The record as it was where history starts.
 const start = pages.at(-1)!.start!;
 const version = parseVersion(await json(request('GET', `${b.base}/history/task/${task}/versions/${start.revision}`, b.member)), { ...target, revision: start.revision });
 assert.deepEqual(versionLines(version.snapshot, 'task', names, words).slice(0, 1), [{ label: 'Title', value: 'Package summer lager' }]);
 assert.ok(versionLines(version.snapshot, 'task', names, words).some(l => l.label === 'Due date' && l.value === date('2031-10-02')));

 // A conflict, then the later change added: applicable.
 const conflict = parsePreview(await json(request('POST', `${b.base}/reversals/preview`, b.member, { changeIds: [due1.id] })), [due1.id]);
 assert.deepEqual([conflict.applicable, conflict.changes[0]!.state, conflict.changes[0]!.proposed], [false, 'conflict', null]);
 const both = parsePreview(await json(request('POST', `${b.base}/reversals/preview`, b.member, { changeIds: [due1.id, due2.id] })), [due1.id, due2.id]);
 assert.deepEqual([both.applicable, both.changes.map(c => c.proposed)], [true, ['2031-10-02', '2031-10-02']]);

 // A stale apply: the refusal's body, through the client's mapping, is the fresh preview and what moved.
 const stalePreview = parsePreview(await json(request('POST', `${b.base}/reversals/preview`, b.owner, { changeIds: [due2.id, attach.id] })), [due2.id, attach.id]);
 assert.ok(stalePreview.applicable);
 await edit(b.member, { expectedRevision: 4, due: '2031-10-09' });
 const refused = await answer(b.owner, 'POST', `${b.base}/reversals`, { id: randomUUID(), changeIds: [due2.id, attach.id], basis: stalePreview.basis }, () => null);
 assert.ok(!refused.ok && refused.kind === 'refused' && refused.code === 'stale_preview' && refused.detail);
 const stale = parseStale(refused.detail, [due2.id, attach.id]);
 assert.deepEqual([stale.moved.map(m => m.revision), stale.preview.changes.map(c => c.state)], [[5], ['conflict', 'reversible']]);

 // The History controller over the real API: load, tick the tag, preview, apply; one request; History shows the undo.
 const scope = { epoch: 'e', userId: b.owner.user.id, organisationId: b.org };
 const client: import('../../../mobile/src/auth/contracts.ts').ApiClient = {
  get: (path, _t, parse) => answer(b.owner, 'GET', path, undefined, parse), post: (path, _t, body, parse) => answer(b.owner, 'POST', path, body, parse),
  patch: (path, _t, body, parse) => answer(b.owner, 'PATCH', path, body, parse), delete: (path, _t, parse) => answer(b.owner, 'DELETE', path, undefined, parse),
 };
 const calls = createThreadCalls(client, { scope: () => scope, sessionEnded() {}, reconcile() {} });
 const store = new Map<string, string>();
 const storage = createPendingUndoStorage(() => ({ getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); }, removeItem: k => { store.delete(k); }, key: i => [...store.keys()][i] ?? null, get length() { return store.size; } }));
 const undoId = randomUUID();
 const history = createHistory({ calls, scope, threadId: thread, now: () => 0, randomId: () => undoId, storage });
 await history.load();
 assert.deepEqual([history.snapshot().phase, history.snapshot().sets.length], ['ready', 6]);
 history.toggle(entryIndex(history.snapshot().sets).get(attach.id)!.entry); history.openPreview();
 for (let i = 0; i < 50 && history.snapshot().sheet?.phase !== 'ready'; i++) await new Promise(r => setTimeout(r, 20));
 assert.equal(history.snapshot().sheet?.preview?.applicable, true);
 history.apply();
 for (let i = 0; i < 100 && history.snapshot().sets[0]?.id !== undoId; i++) await new Promise(r => setTimeout(r, 20));
 assert.deepEqual([history.snapshot().notice, history.snapshot().sets[0]!.id, history.snapshot().sets[0]!.causeKind, store.size], ['1 change undone.', undoId, 'reversal', 0]);
 assert.equal(entryIndex(history.snapshot().sets).get(attach.id)!.entry.state, 'reversed');
 const lines = parseMessages(await json(request('GET', `${b.threads}/${thread}/messages?latest=50`, b.member))).messages.filter(m => m.changeSetId === undoId);
 assert.equal(lines.length, 1, 'the thread shows the undo as a change line');
 history.dispose();

 // A booking moved, its old slot taken since: the preview is blocked, naming the booking that holds it.
 const tank = (await json<{ id: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Canning line' }), 201)).id;
 const booking = await json<{ id: string }>(request('POST', `${b.base}/equipment/${tank}/reservations`, b.owner, { id: randomUUID(), title: 'Can the lager', startsAt: '2031-10-08T08:00:00Z', endsAt: '2031-10-08T12:00:00Z' }), 201);
 await json(request('PATCH', `${b.base}/equipment/${tank}/reservations/${booking.id}`, b.owner, { expectedRevision: 1, title: 'Can the lager', kind: 'booking', startsAt: '2031-10-09T13:00:00Z', endsAt: '2031-10-09T17:00:00Z', setupMinutes: 0, cleanupMinutes: 0, taskId: null, ownerId: null }));
 await json(request('POST', `${b.base}/equipment/${tank}/reservations`, b.member, { id: randomUUID(), title: 'Keg wash', startsAt: '2031-10-08T08:00:00Z', endsAt: '2031-10-08T12:00:00Z', setupMinutes: 30, cleanupMinutes: 30, ownerId: b.member.user.id }), 201);
 const bookingHistory = parseHistory(await json(request('GET', `${b.base}/history/reservation/${booking.id}`, b.member)), { kind: 'reservation', id: booking.id });
 const moved = bookingHistory.changeSets[0]!.changes.find(c => c.field === 'time')!;
 assert.deepEqual(moved.fields.sort(), ['endsAt', 'startsAt']);
 const blocked = parsePreview(await json(request('POST', `${b.base}/reversals/preview`, b.member, { changeIds: moved.changeIds })), moved.changeIds);
 const entry = blocked.changes[0]!;
 assert.ok(entry.state === 'blocked' && entry.reason === 'slot_taken');
 assert.equal(blockedReason(entry as typeof entry & { state: 'blocked' }, blocked.names, { ...words, equipmentName: 'Canning line' }), `This can’t be undone now. Keg wash (Mia ${n}) holds the Canning line on ${date('2031-10-08')} from 7:30 am to 12:30 pm.`);

 // A topic's own tag history, then topic to task; a private thread is refused in the client's words.
 const topic = await json<Detail>(b.topic(b.member, 'Order pallet wrap before the canning run'), 201);
 await tagged(b, topic.thread.id, tag.id);
 const own = parseHistory(await json(request('GET', `${b.base}/history/thread/${topic.thread.id}`, b.member)), { kind: 'thread', id: topic.thread.id });
 assert.deepEqual(own.changeSets.map(s => s.changes.map(c => [c.operation, c.itemKind])), [[['attach', 'tag']]]);
 const revision = (await b.detail(b.member, topic.thread.id)).thread.revision;
 const made = parseMadeTask(await json(request('POST', `${b.threads}/${topic.thread.id}/task`, b.member, makeTaskBody(randomUUID(), revision, b.member.user.id, '2031-10-05'))), topic.thread.id);
 assert.deepEqual([made.thread.kind, made.card.record?.kind, made.card.fold.due], ['record', 'task', '2031-10-05']);
 const secret = (await json<Detail>(request('POST', b.threads, b.member, { id: randomUUID(), kind: 'private', title: 'Margins', participantIds: [] }), 201)).thread.id;
 const refusal = await answer(b.member, 'POST', `${b.threads}/${secret}/task`, makeTaskBody(randomUUID(), 1, null, ''), () => null);
 assert.deepEqual(refusal, { ok: false, kind: 'refused', status: 400, code: 'thread_not_topic' });
});
