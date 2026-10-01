import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
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
type Message = { id: string; seq: number; body: string | null };
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
 assert.deepEqual(groups[production.id], { key: production.id, label: 'Production', threads: 2, needsYou: 0, owner: null, startsOn: null, endsOn: null },
  'the private thread is not counted for someone outside it');
 assert.deepEqual(groups[launch.id], { key: launch.id, label: 'Summer lager launch', threads: 2, needsYou: 1, owner: { id: b.member.user.id, name: `Mia ${people}` }, startsOn: '2031-06-01', endsOn: '2031-08-31' });
 // A topic's first message is unread for everyone but its author.
 assert.deepEqual(groups.none, { key: 'none', label: 'Other', threads: 5, needsYou: 2, owner: null, startsOn: null, endsOn: null });
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
 const tags = await db.owner<{ id: string }[]>`insert into tags (organisation_id, name) select ${b.org}, 'Tag ' || lpad(g::text, 3, '0') from generate_series(1, 101) g returning id`;
 const task = await b.task('Tagged a lot'), busy = await b.task('Tagged twice');
 const [thread, busyThread] = [await b.threadOf('task_id', task), await b.threadOf('task_id', busy)];
 await db.owner`insert into thread_tags (organisation_id, thread_id, tag_id) select ${b.org}, ${thread}, id from tags where organisation_id = ${b.org}`;
 await db.owner`insert into thread_tags (organisation_id, thread_id, tag_id) values (${b.org}, ${busyThread}, ${tags[100]!.id})`;
 await b.task('Untagged');
 const groups = (await b.list(b.member)).groups;
 assert.equal(groups.length, groupLimit);
 assert.deepEqual(groups[0], { key: tags[100]!.id, label: 'Tag 101', threads: 2, needsYou: 0, owner: null, startsOn: null, endsOn: null }, 'the largest first');
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
 assert.equal((await row(mineThread)).needsYou, true, 'an open task I own');
 assert.equal((await row(bookingThread)).needsYou, true, 'an upcoming booking I own');
 assert.equal((await row(theirsThread)).needsYou, false);
 assert.equal((await row(doneThread)).needsYou, false, 'done is not waiting on me');
 await b.send(b.owner, theirsThread, 'Can you look at this?');
 await b.send(b.member, doneThread, 'My own words are never unread');
 const theirsRow = await row(theirsThread);
 assert.deepEqual([theirsRow.unread, theirsRow.needsYou], [1, true], 'never opened: the whole thread is unread');
 assert.deepEqual([(await row(doneThread)).unread, (await row(doneThread)).needsYou], [0, false]);
 assert.deepEqual((await b.list(b.member, 'filter=needs_you')).threads.map(t => t.id).sort(), [mineThread, theirsThread, bookingThread].sort());
 assert.equal((await b.list(b.member)).groups.find(g => g.key === 'none')!.needsYou, 3);
 assert.deepEqual(await json(request('POST', `${b.threads}/${theirsThread}/read`, b.member, { seq: 1 })), { readPosition: 1, unread: 0 });
 assert.equal((await row(theirsThread)).needsYou, false);
 assert.equal((await b.detail(b.other, theirsThread)).thread.readPosition, 0, 'a read position is personal');
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
 const said = (await json<{ messages: Message[] }>(request('GET', `${b.threads}/${secret}/messages?latest=1`, b.owner))).messages[0]!;
 await json(request('POST', `${b.threads}/${secret}/pin`, b.owner, { messageId: said.id }), 201);
 // Rows and detail carry no links: R2 has no way to write one.
 assert.ok(!('links' in (await b.detail(b.admin, secret))) && !('links' in (await b.list(b.admin)).threads.find(t => t.id === secret)!));
 // The member: the record thread is theirs to see, the private thread is not, by any path.
 assert.equal((await b.detail(b.member, record)).thread.lastSeq, 1);
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
