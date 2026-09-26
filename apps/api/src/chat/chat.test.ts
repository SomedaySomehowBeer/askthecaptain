import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { after, before, test } from 'node:test';
import { withTenant, type TransactionSql } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { OrganisationLifecycle } from '../organisations/lifecycle.ts';
import { RateLimiter } from '../ratelimit.ts';
import { createFingerprint, decodeCursor, encodeCursor, normaliseBody, validActivityKey } from './service.ts';

// Linked chat PR B (docs/plans/linked-chat-2026-09.md) through the real app and real Postgres, connected as the harness's
// restricted runtime role (`captain_runtime`, D6): row security is the authority for every chat read and write here.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
type Participant = { userId: string; name: string };
type Link = { id: string; kind: 'task' | 'project'; targetId: string; title: string; state: string };
type Detail = { id: string; title: string; revision: number; lastSeq: number; lastChange: number; createdBy: string | null; participants: Participant[]; links: Link[];
 starred: boolean; lastReadSeq: number; unread: number };
type Message = { id: string; conversationId: string; seq: number; changeSeq: number; authorId: string | null; authorName: string | null; body: string | null;
 deletedAt: string | null; editedAt: string | null; revision: number };
type Pin = { id: string; conversationId: string; messageId: string; changeSeq: number; pinnedBy: string | null; unpinnedBy: string | null; unpinnedAt: string | null };
type Page = { conversation: { id: string; revision: number; lastSeq: number; lastChange: number }; messages: Message[]; hasMore: boolean };
type Change = { changeSeq: number; kind: 'message'; message: Message } | { changeSeq: number; kind: 'pin'; pin: Pin };
type Changes = { conversation: { highWater: number }; changes: Change[]; next: number; complete: boolean };
type Failure = { ok: false; code: string; error: string };
const messageOf = (change: Change): Message => { assert.equal(change.kind, 'message'); return (change as Extract<Change, { kind: 'message' }>).message; };
let owner: Person, member: Person, admin: Person, third: Person, outsider: Person, org: string, otherOrg: string;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
 next: { subject: 'owner', email: 'owner@example.test', name: 'Owner' },
 authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`, async exchange() { return google.next; },
};
const request = (method: string, path: string, person?: Person, data?: unknown, target = app) => target.request(path, { method,
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
const join = (person: Person, role: 'member' | 'admin' = 'member', organisationId = org) =>
 db.owner`insert into memberships (organisation_id, user_id, role) values (${organisationId}, ${person.user.id}, ${role})`;
const base = (organisationId = org) => `/v1/organisations/${organisationId}`;
const chats = (organisationId = org) => `${base(organisationId)}/conversations`;
const create = (person: Person, body: unknown, organisationId = org) => request('POST', chats(organisationId), person, body);
const newChat = (person: Person, title: string, others: Person[] = [], links: { kind: 'task' | 'project'; targetId: string }[] = []) =>
 json<Detail>(create(person, { id: randomUUID(), title, participantIds: others.map(p => p.user.id), links }), 201);
const detail = (person: Person, id: string) => request('GET', `${chats()}/${id}`, person);
const send = (person: Person, conversation: string, body: string, id: string = randomUUID()) => request('POST', `${chats()}/${conversation}/messages`, person, { id, body });
const page = (person: Person, conversation: string, query: string) => request('GET', `${chats()}/${conversation}/messages?${query}`, person);
const changes = (person: Person, conversation: string, query: string) => request('GET', `${chats()}/${conversation}/changes?${query}`, person);
const addPeople = (person: Person, conversation: string, expectedRevision: number, people: Person[]) =>
 request('POST', `${chats()}/${conversation}/participants`, person, { expectedRevision, userIds: people.map(p => p.user.id) });
const removePerson = (person: Person, conversation: string, target: Person, expectedRevision: number) =>
 request('DELETE', `${chats()}/${conversation}/participants/${target.user.id}?expectedRevision=${expectedRevision}`, person);
const makeTask = async (title: string) => (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title }), 201)).id;
const makeProject = async (name: string) => (await json<{ id: string }>(request('POST', `${base()}/projects`, owner, { name }), 201)).id;
const asApp = <T>(person: Person, work: (tx: TransactionSql) => Promise<T>, organisationId = org) => withTenant(db.app, { organisationId, userId: person.user.id }, work);
const chatAudit = (conversation: string) => db.owner<{ action: string; actorId: string | null; detail: Record<string, unknown>; personal: boolean }[]>`
 select action, actor_id, detail, personal from chat_audit_events where conversation_id = ${conversation} order by created_at, id`;

before(async () => {
 if (!databaseUrl) return;
 db = await freshDatabase();
 // Every request lands in a fresh window: these tests exercise chat, not the rate limiter (tested separately below).
 let clock = Date.now();
 app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
  organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), lifecycle: new OrganisationLifecycle(db.app),
  rateLimiter: new RateLimiter(() => (clock += 61_000)) });
 owner = await signIn('chat-owner', 'Olive Owner'); member = await signIn('chat-member', 'Mia Member');
 admin = await signIn('chat-admin', 'Ada Admin'); third = await signIn('chat-third', 'Theo Third'); outsider = await signIn('chat-outsider', 'Oscar Outsider');
 org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name: 'Harbour Brewing' }), 201)).id;
 otherOrg = (await json<{ id: string }>(request('POST', '/v1/organisations', outsider, { name: 'Other business' }), 201)).id;
 await join(member); await join(admin, 'admin'); await join(third);
});
after(async () => { await db?.close(); });

test('bodies are trimmed and bounded by code points and bytes; fingerprints ignore order but not content', () => {
 assert.equal(normaliseBody('  hello \n'), 'hello');
 assert.throws(() => normaliseBody('   '), /1 to 4,000/);
 assert.equal(normaliseBody('🍺'.repeat(4000)).length, 8000, '4,000 code points of astral characters is allowed');
 assert.throws(() => normaliseBody('a'.repeat(4001)));
 const a = createFingerprint({ title: 'T', participantIds: ['b', 'a'], links: [{ kind: 'task', targetId: '2' }, { kind: 'project', targetId: '1' }] });
 const b = createFingerprint({ title: 'T', participantIds: ['a', 'b'], links: [{ kind: 'project', targetId: '1' }, { kind: 'task', targetId: '2' }] });
 assert.ok(a.equals(b)); assert.equal(a.length, 32);
 assert.ok(!a.equals(createFingerprint({ title: 'T ', participantIds: ['a', 'b'], links: [] })));
});

test('list cursors accept only the exact UTC activity key the list query writes, with a real calendar date', () => {
 const id = randomUUID();
 assert.ok(validActivityKey('2026-09-26T03:28:49.123456Z'));
 assert.ok(validActivityKey('2028-02-29T23:59:59.000000Z'));
 for (const bad of ['garbage', '', '2026-09-26 03:28:49.123456+00', '2026-09-26T03:28:49Z', '2026-09-26T03:28:49.123Z', '2026-02-30T00:00:00.000000Z',
  '2026-13-01T00:00:00.000000Z', '2026-09-26T24:00:00.000000Z', '0000-01-01T00:00:00.000000Z', ' 2026-09-26T03:28:49.123456Z'])
  assert.equal(validActivityKey(bad), false, bad);
 assert.deepEqual(decodeCursor(encodeCursor('2026-09-26T03:28:49.123456Z', id.toUpperCase())), ['2026-09-26T03:28:49.123456Z', id]);
 for (const cursor of [encodeCursor('garbage', id), encodeCursor('2026-09-26T03:28:49.123456Z', 'not-a-uuid'), 'not base64 json',
  Buffer.from('{"a":1}').toString('base64url'), Buffer.from(JSON.stringify(['2026-09-26T03:28:49.123456Z', id, 'extra'])).toString('base64url')])
  assert.throws(() => decodeCursor(cursor), /cannot be read/, cursor);
});

it('lists pages by most recent activity with an opaque cursor, and refuses crafted cursors with 400, not 500', async () => {
 const pager = await signIn('chat-pager', 'Pia Pager'); await join(pager);
 const first = await newChat(pager, 'First'), second = await newChat(pager, 'Second'), last = await newChat(pager, 'Third');
 await json(send(pager, first.id, 'Bring this one to the top'), 201);
 type Listed = { conversations: { id: string }[]; nextCursor: string | null };
 const seen: string[] = []; let cursor: string | null = null, rounds = 0;
 do {
  const path: string = `${chats()}?limit=1${cursor === null ? '' : `&cursor=${cursor}`}`;
  const listed: Listed = await json<Listed>(request('GET', path, pager));
  seen.push(...listed.conversations.map((c: { id: string }) => c.id));
  cursor = listed.nextCursor;
 } while (cursor !== null && rounds++ < 10);
 assert.deepEqual(seen, [first.id, last.id, second.id], 'newest activity first, each exactly once, ending with a null cursor');
 const id = randomUUID();
 for (const bad of [encodeCursor('garbage', id), encodeCursor('2026-02-30T00:00:00.000000Z', id), encodeCursor('2026-09-26 03:28:49.123456+00', id), 'x'])
  assert.equal((await json<Failure>(request('GET', `${chats()}?cursor=${encodeURIComponent(bad)}`, pager), 400)).code, 'invalid_request', bad);
 assert.equal((await request('GET', `${chats()}?limit=51`, pager)).status, 400);
 assert.equal((await request('GET', `${chats()}?limit=1&limit=2`, pager)).status, 400);
});

it('a conversation links at most ten tasks or projects, checked under its lock', async () => {
 const chat = await newChat(owner, 'Many links');
 let revision = 1;
 for (let i = 0; i < 10; i++) {
  const task = await makeTask(`Linked task ${i}`);
  revision = (await json<Detail>(request('POST', `${chats()}/${chat.id}/links`, owner, { expectedRevision: revision, kind: 'task', targetId: task }), 201)).revision;
 }
 const extra = await makeTask('One too many');
 assert.equal((await json<Failure>(request('POST', `${chats()}/${chat.id}/links`, owner, { expectedRevision: revision, kind: 'task', targetId: extra }), 409)).code, 'link_limit');
 assert.equal((await db.owner<{ n: number }[]>`select count(*)::int as n from conversation_links where conversation_id = ${chat.id}`)[0]!.n, 10);
 // A duplicate link is its own conflict, and never a second row.
 const again = (await json<Detail>(detail(owner, chat.id))).links[0]!;
 assert.equal((await json<Failure>(request('POST', `${chats()}/${chat.id}/links`, owner, { expectedRevision: revision, kind: again.kind, targetId: again.targetId }), 409)).code, 'link_exists');
});

it('a conversation holds at most fifty people, including under concurrent adds', async () => {
 const tag = randomUUID().slice(0, 8);
 const crowd = (await db.owner<{ id: string }[]>`insert into users (email, name)
  select 'crowd-' || g || '-' || ${tag} || '@example.test', 'Crowd ' || lpad(g::text, 2, '0') from generate_series(1, 51) g returning id`).map(row => row.id);
 await db.owner`insert into memberships (organisation_id, user_id, role) select ${org}, id, 'member' from users where id in ${db.owner(crowd)}`;
 const count = async (id: string) => (await db.owner<{ n: number }[]>`select count(*)::int as n from conversation_participants where conversation_id = ${id} and state = 'active'`)[0]!.n;
 const add = (id: string, revision: number, userIds: string[]) => request('POST', `${chats()}/${id}/participants`, owner, { expectedRevision: revision, userIds });
 const chat = await json<Detail>(create(owner, { id: randomUUID(), title: 'Crowded', participantIds: crowd.slice(0, 47), links: [] }), 201);
 assert.equal(await count(chat.id), 48);
 assert.equal((await json<Failure>(add(chat.id, 1, crowd.slice(47, 50)), 409)).code, 'participant_limit', '48 + 3 would pass the cap; nobody is added');
 assert.equal(await count(chat.id), 48);
 await json(add(chat.id, 1, [crowd[47]!]));
 // Two adds from the same revision: the conversation lock serialises them, so exactly one lands.
 const race = await Promise.all([add(chat.id, 2, [crowd[48]!]), add(chat.id, 2, [crowd[49]!])]);
 assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
 assert.equal(await count(chat.id), 50);
 assert.equal((await json<Failure>(add(chat.id, 3, [crowd[50]!]), 409)).code, 'participant_limit');
 assert.equal(await count(chat.id), 50, 'the cap holds');
 // At creation the cap counts people: naming yourself, or someone twice, does not use a place (51 raw entries, 50 people).
 const full = await json<Detail>(create(owner, { id: randomUUID(), title: 'Full', participantIds: [owner.user.id, ...crowd.slice(0, 49), crowd[0]!.toUpperCase()], links: [] }), 201);
 assert.equal(await count(full.id), 50);
 // The request itself stays bounded: more than 100 entries is refused before anything else.
 assert.equal((await json<Failure>(create(owner, { id: randomUUID(), title: 'Huge', participantIds: Array.from({ length: 101 }, () => crowd[0]!), links: [] }), 400)).code, 'invalid_request');
 const tooMany = randomUUID();
 assert.equal((await json<Failure>(create(owner, { id: tooMany, title: 'Too many', participantIds: crowd.slice(0, 50), links: [] }), 409)).code, 'participant_limit');
 assert.equal((await db.owner`select 1 from conversations where id = ${tooMany}`).length, 0, 'nothing is created');
});

it('creates a linked conversation, sends and reads messages, and shows it only to its participants', async () => {
 const task = await makeTask('Confirm packaging slot'), project = await makeProject('Summer lager');
 const created = await newChat(owner, '  Packaging slot  ', [member], [{ kind: 'task', targetId: task }, { kind: 'project', targetId: project }]);
 assert.equal(created.title, 'Packaging slot'); assert.equal(created.revision, 1); assert.equal(created.createdBy, owner.user.id);
 assert.deepEqual(created.participants.map(p => p.name), ['Mia Member', 'Olive Owner']);
 assert.deepEqual(created.links.map(l => [l.kind, l.targetId, l.title]).sort(), [['project', project, 'Summer lager'], ['task', task, 'Confirm packaging slot']]);

 const first = await json<Message>(send(member, created.id, '  Keep the existing reservation.  '), 201);
 const second = await json<Message>(send(owner, created.id, 'Agreed.'), 201);
 assert.deepEqual([first.seq, second.seq, first.body], [1, 2, 'Keep the existing reservation.']);
 const latest = await json<Page>(page(member, created.id, 'latest=6'));
 assert.deepEqual(latest.messages.map(m => m.id), [first.id, second.id]); assert.equal(latest.hasMore, false);
 assert.equal(latest.conversation.lastSeq, 2); assert.equal(latest.conversation.revision, 1, 'sends never move the revision');
 const synced = await json<Changes>(changes(member, created.id, 'after=0'));
 assert.deepEqual(synced.changes.map(c => messageOf(c).id), [first.id, second.id]); assert.equal(synced.complete, true); assert.equal(synced.next, synced.conversation.highWater);

 // Work to chat: the participant sees it from the task and the project; a non-participant sees nothing, not even a count.
 assert.deepEqual((await json<{ conversations: { id: string }[] }>(request('GET', `${base()}/tasks/${task}/conversations`, member))).conversations.map(c => c.id), [created.id]);
 assert.deepEqual(await json(request('GET', `${base()}/projects/${project}/conversations`, third)), { conversations: [] });
 assert.equal((await request('GET', `${base()}/tasks/${randomUUID()}/conversations`, member)).status, 404);

 // Not a participant: the same 404 for a member, a non-participant admin, a stranger and an unknown id.
 const notFound = async (response: Response | Promise<Response>) => { const r = await response; assert.equal(r.status, 404); return r.text(); };
 const bodies = new Set([
  await notFound(detail(third, created.id)), await notFound(detail(admin, created.id)), await notFound(detail(member, randomUUID())),
  await notFound(page(third, created.id, 'latest=6')), await notFound(changes(admin, created.id, 'after=0')), await notFound(send(third, created.id, 'hi')),
 ]);
 assert.equal(bodies.size, 1, 'every inaccessible read and write answers identically');
 assert.equal((await detail(outsider, created.id)).status, 404);
 assert.deepEqual((await json<{ conversations: unknown[] }>(request('GET', chats(), third))).conversations, []);
 assert.deepEqual((await json<{ conversations: { id: string }[] }>(request('GET', chats(), member))).conversations.map(c => c.id), [created.id]);
 // Direct SQL as app: a non-participant sees zero rows in every chat table.
 for (const table of ['conversations', 'conversation_participants', 'conversation_links', 'messages', 'chat_audit_events'])
  assert.equal((await asApp(third, tx => tx.unsafe(`select 1 from ${table}`))).length, 0, table);

 // Audit: nothing in the tenant-wide log; IDs and counters only in chat audit.
 const tenantAudit = await db.owner<{ action: string; detail: unknown }[]>`select action, detail from audit_events where organisation_id = ${org}`;
 assert.ok(!tenantAudit.some(a => a.action.startsWith('chat.') || JSON.stringify(a.detail).includes(created.id)));
 const trail = await chatAudit(created.id);
 assert.deepEqual(trail.map(a => a.action), ['chat.conversation_created', 'chat.participant_added', 'chat.link_added', 'chat.link_added', 'chat.message_sent', 'chat.message_sent']);
 const text = JSON.stringify(trail);
 for (const secret of ['Packaging slot', 'Keep the existing', 'Agreed', 'Summer lager']) assert.ok(!text.includes(secret), `chat audit must not carry ${secret}`);
});

it('rejects stale conversation writes and never replays an old add over a later removal', async () => {
 const chat = await newChat(owner, 'Stale checks', [member]);
 const renamed = await json<Detail>(request('PATCH', `${chats()}/${chat.id}`, member, { expectedRevision: 1, title: 'Renamed' }));
 assert.equal(renamed.revision, 2);
 assert.equal((await json<Failure>(request('PATCH', `${chats()}/${chat.id}`, owner, { expectedRevision: 1, title: 'Late' }), 409)).code, 'stale_revision');
 const added = await json<Detail>(addPeople(owner, chat.id, 2, [third]));
 assert.equal(added.revision, 3); assert.ok(added.participants.some(p => p.userId === third.user.id));
 // A member cannot remove someone else; an admin who is not a participant cannot even see it.
 assert.equal((await removePerson(member, chat.id, third, 3)).status, 403);
 assert.equal((await removePerson(admin, chat.id, third, 3)).status, 404);
 await json(addPeople(owner, chat.id, 3, [admin]));
 await json(removePerson(admin, chat.id, third, 4));
 assert.equal((await detail(third, chat.id)).status, 404, 'removal ends access at once');
 // The delayed add from revision 3 cannot undo the later removal.
 assert.equal((await json<Failure>(addPeople(owner, chat.id, 3, [third]), 409)).code, 'stale_revision');
 assert.equal((await detail(third, chat.id)).status, 404);
 // Everyone named must be an active member of this organisation, or nobody is added.
 assert.equal((await json<Failure>(addPeople(owner, chat.id, 5, [third, outsider]), 400)).code, 'participant_unavailable');
 assert.equal((await detail(third, chat.id)).status, 404);
 // An explicit re-add is the only way back in.
 await json(addPeople(owner, chat.id, 5, [third]));
 assert.equal((await detail(third, chat.id)).status, 200);
});

it('a leave audits before access ends, and a stale leave never removes someone re-added since', async () => {
 const chat = await newChat(owner, 'Leaving', [member]);
 assert.deepEqual(await json(removePerson(member, chat.id, member, 1)), { ok: true, revision: 2 });
 assert.equal((await detail(member, chat.id)).status, 404);
 const trail = await chatAudit(chat.id);
 assert.equal(trail.at(-1)!.action, 'chat.participant_left'); assert.equal(trail.at(-1)!.actorId, member.user.id);
 assert.equal(trail.filter(a => a.action === 'chat.participant_left').length, 1, 'exactly one leave row');
 // Leaving again, now a non-participant, even with the current revision: the same 404, and nothing written.
 assert.equal((await removePerson(member, chat.id, member, 2)).status, 404);
 assert.equal((await chatAudit(chat.id)).length, trail.length);
 assert.equal((await db.owner<{ revision: number }[]>`select revision from conversations where id = ${chat.id}`)[0]!.revision, 2);
 await json(addPeople(owner, chat.id, 2, [member]));
 assert.equal((await removePerson(member, chat.id, member, 1)).status, 409, 'the replayed leave is stale');
 assert.equal((await detail(member, chat.id)).status, 200);

 // Atomicity at the database: an audit row written before a failing participant change rolls back with it.
 const requestId = `leave-rollback-${randomUUID()}`;
 await assert.rejects(asApp(member, async tx => {
  await tx`insert into chat_audit_events (organisation_id, conversation_id, actor_id, action, subject_kind, subject_id, personal, request_id, detail)
   values (${org}, ${chat.id}, ${member.user.id}, 'chat.participant_left', 'participant', ${member.user.id}, false, ${requestId}, '{}'::jsonb)`;
  await tx`update conversation_participants set user_id = ${third.user.id} where conversation_id = ${chat.id} and user_id = ${member.user.id}`;
 }));
 assert.equal((await db.owner`select 1 from chat_audit_events where request_id = ${requestId}`).length, 0);
 assert.equal((await detail(member, chat.id)).status, 200, 'still a participant');
});

it('create and send retries return the stored record, and every other use of an id is one generic 409', async () => {
 const id = randomUUID();
 const body = { id, title: 'Retry me', participantIds: [member.user.id], links: [{ kind: 'task' as const, targetId: await makeTask('Retried link') }] };
 const first = await json<Detail>(create(owner, body), 201);
 const written = async () => (await db.owner<{ people: number; links: number; audit: number }[]>`select
  (select count(*)::int from conversation_participants where conversation_id = ${id}) as people,
  (select count(*)::int from conversation_links where conversation_id = ${id}) as links,
  (select count(*)::int from chat_audit_events where conversation_id = ${id}) as audit`)[0]!;
 const once = await written();
 assert.deepEqual(once, { people: 2, links: 1, audit: 3 });
 assert.equal((await json<Detail>(create(owner, body), 200)).id, first.id);
 assert.deepEqual(await written(), once, 'a matched retry writes nothing: no participant, link or audit row');
 await json(request('PATCH', `${chats()}/${id}`, owner, { expectedRevision: 1, title: 'Renamed since' }));
 const again = await json<Detail>(create(owner, body), 200);
 assert.equal(again.title, 'Renamed since', 'a matching retry returns the current conversation');
 assert.equal((await db.owner`select 1 from conversations where id = ${id}`).length, 1);
 const conflicts = [
  await json<Failure>(create(owner, { ...body, title: 'Different' }), 409),
  await json<Failure>(create(member, body), 409),
  await json<Failure>(create(outsider, body, otherOrg), 409),
 ];
 assert.ok(conflicts.every(c => c.code === 'conversation_id_unavailable'));
 assert.equal(new Set(conflicts.map(c => JSON.stringify(c))).size, 1, 'no hint about who holds the id');

 const messageId = randomUUID();
 const sent = await json<Message>(send(member, id, 'Once only', messageId), 201);
 assert.equal((await json<Message>(send(member, id, '  Once only ', messageId), 200)).seq, sent.seq, 'a normalised identical retry');
 const other = await newChat(member, 'Another room', [owner]);
 const refused = [
  await json<Failure>(send(member, id, 'Changed text', messageId), 409),
  await json<Failure>(send(owner, id, 'Once only', messageId), 409),
  await json<Failure>(send(member, other.id, 'Once only', messageId), 409),
 ];
 await json<Message>(request('DELETE', `${chats()}/${id}/messages/${messageId}?expectedRevision=1`, member));
 refused.push(await json<Failure>(send(member, id, 'Once only', messageId), 409));
 assert.ok(refused.every(c => c.code === 'message_id_unavailable'));
 assert.equal(new Set(refused.map(c => JSON.stringify(c))).size, 1);
 const tombstone = (await json<Page>(page(owner, id, 'latest=10'))).messages.find(m => m.id === messageId)!;
 assert.equal(tombstone.body, null, 'not resurrected'); assert.ok(tombstone.deletedAt);
 assert.equal((await json<Page>(page(owner, id, 'latest=10'))).conversation.lastSeq, 1, 'refused sends advanced no counter');
});

it('concurrent uses of one client id by different people give exactly one success and one generic 409', async () => {
 const id = randomUUID();
 const results = await Promise.all([
  create(owner, { id, title: 'Race A', participantIds: [], links: [] }),
  create(member, { id, title: 'Race B', participantIds: [], links: [] }),
  create(outsider, { id, title: 'Race C', participantIds: [], links: [] }, otherOrg),
 ]);
 assert.deepEqual(results.map(r => r.status).sort(), [201, 409, 409]);
 for (const r of results.filter(r => r.status === 409)) assert.equal(((await r.json()) as Failure).code, 'conversation_id_unavailable');

 const roomA = await newChat(owner, 'Room A'), roomB = await newChat(member, 'Room B');
 const messageId = randomUUID();
 const sends = await Promise.all([send(owner, roomA.id, 'A', messageId), send(member, roomB.id, 'B', messageId)]);
 assert.deepEqual(sends.map(r => r.status).sort(), [201, 409]);
 const loser = sends.find(r => r.status === 409)!;
 assert.equal(((await loser.json()) as Failure).code, 'message_id_unavailable');
});

it('concurrent sends get dense, unique seq values and the change feed converges by id', async () => {
 const chat = await newChat(owner, 'Busy', [member]);
 const sent = await Promise.all(Array.from({ length: 12 }, (_, i) => json<Message>(send(i % 2 ? owner : member, chat.id, `Message ${i}`), 201)));
 assert.deepEqual(sent.map(m => m.seq).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
 // A tombstone reappears at a later change; paging by one converges to the server's state.
 const victim = sent.find(m => m.seq === 3)!;
 await json(request('DELETE', `${chats()}/${chat.id}/messages/${victim.id}?expectedRevision=1`, member.user.id === victim.authorId ? member : owner));
 const seen = new Map<string, { changeSeq: number; message: Message }>();
 let cursor = 0, complete = false, rounds = 0;
 while (!complete && rounds++ < 50) {
  const batch = await json<Changes>(changes(owner, chat.id, `after=${cursor}&limit=1`));
  for (const change of batch.changes) { const message = messageOf(change); const known = seen.get(message.id); if (!known || known.changeSeq < change.changeSeq) seen.set(message.id, { changeSeq: change.changeSeq, message }); }
  assert.ok(batch.next >= cursor); cursor = batch.next; complete = batch.complete;
 }
 assert.equal(seen.size, 12);
 assert.equal(seen.get(victim.id)!.message.body, null);
 const pageAll = await json<Page>(page(owner, chat.id, 'after=0&limit=100'));
 assert.deepEqual([...seen.values()].map(v => v.message).sort((a, b) => a.seq - b.seq), pageAll.messages);
 const conversation = (await json<Page>(page(owner, chat.id, 'latest=1'))).conversation;
 assert.equal(conversation.lastSeq, 12); assert.equal(conversation.lastChange, 13); assert.equal(conversation.revision, 1);
 // Only the author or an owner/admin participant may tombstone; a second delete is 404.
 const mine = sent.find(m => m.authorId === owner.user.id && m.id !== victim.id)!;
 assert.equal((await request('DELETE', `${chats()}/${chat.id}/messages/${mine.id}?expectedRevision=1`, member)).status, 403);
 await json(request('DELETE', `${chats()}/${chat.id}/messages/${mine.id}?expectedRevision=1`, owner));
 assert.equal((await request('DELETE', `${chats()}/${chat.id}/messages/${mine.id}?expectedRevision=2`, owner)).status, 404);
});

it('removal from the organisation ends participation for good, and concurrent removals by one admin finish', async () => {
 const leaver = await signIn('chat-leaver', 'Lee Leaver'), other = await signIn('chat-other', 'Ola Other');
 await join(leaver); await join(other);
 const shared = await newChat(owner, 'Shared', [leaver, other]);
 // A conversation the removing owner is not in: the removal must still end the leaver's participation there.
 const aside = await newChat(member, 'Without the owner', [leaver]);
 await json(send(leaver, shared.id, 'Before I go'), 201);
 await Promise.all([
  json(request('DELETE', `${base()}/members/${leaver.user.id}`, owner)),
  json(request('DELETE', `${base()}/members/${other.user.id}`, owner)),
 ]);
 const states = await db.owner<{ userId: string; state: string }[]>`select user_id, state from conversation_participants where conversation_id = ${shared.id} order by user_id`;
 assert.deepEqual(states.filter(s => s.userId !== owner.user.id).map(s => s.state), ['removed', 'removed']);
 const asideStates = await db.owner<{ userId: string; state: string }[]>`select user_id, state from conversation_participants where conversation_id = ${aside.id}`;
 assert.deepEqual(new Map(asideStates.map(s => [s.userId, s.state])), new Map([[member.user.id, 'active'], [leaver.user.id, 'removed']]));
 // The remover learns nothing about it: not through the API, and not by reading the rows it changed.
 assert.equal((await detail(owner, aside.id)).status, 404);
 for (const [table, column] of [['conversations', 'id'], ['conversation_participants', 'conversation_id'], ['chat_audit_events', 'conversation_id']] as const)
  assert.equal((await asApp(owner, tx => tx.unsafe(`select 1 from ${table} where ${column} = $1`, [aside.id]))).length, 0, table);
 // Reactivating the membership restores nothing.
 await db.owner`update memberships set status = 'active' where organisation_id = ${org} and user_id = ${leaver.user.id}`;
 assert.equal((await detail(leaver, shared.id)).status, 404);
 assert.deepEqual((await json<{ conversations: unknown[] }>(request('GET', chats(), leaver))).conversations, []);
 // Their message stays; the organisation audit says only that a member was removed.
 assert.equal((await json<Page>(page(owner, shared.id, 'latest=6'))).messages[0]!.body, 'Before I go');
 const removed = await db.owner<{ detail: unknown }[]>`select detail from audit_events where organisation_id = ${org} and action = 'membership.removed' and subject_id = ${leaver.user.id}`;
 assert.ok(!JSON.stringify(removed).includes(shared.id));
});

it('a create naming several people, racing the organisation removal of one of them, is all-or-nothing', async () => {
 const racer = await signIn('chat-racer', 'Rae Racer'), stayer = await signIn('chat-stayer', 'Sam Stayer');
 await join(racer); await join(stayer);
 const id = randomUUID();
 // Both lock memberships first, in user-id order (contract §6), so neither can deadlock the other.
 const [created, removed] = await Promise.all([
  create(member, { id, title: 'Racing', participantIds: [racer.user.id, stayer.user.id], links: [] }),
  request('DELETE', `${base()}/members/${racer.user.id}`, owner),
 ]);
 assert.equal(removed.status, 200, await removed.clone().text());
 const rows = new Map((await db.owner<{ userId: string; state: string }[]>`select user_id, state from conversation_participants where conversation_id = ${id}`)
  .map(row => [row.userId, row.state]));
 if (created.status === 201) {
  // The create committed first; the removal then ended the racer's participation with everyone else untouched.
  assert.deepEqual(rows, new Map([[member.user.id, 'active'], [racer.user.id, 'removed'], [stayer.user.id, 'active']]));
 } else {
  assert.equal(created.status, 400, await created.clone().text());
  assert.equal(((await created.json()) as Failure).code, 'participant_unavailable');
  assert.equal(rows.size, 0);
  assert.equal((await db.owner`select 1 from conversations where id = ${id}`).length, 0, 'nothing is half-created');
 }
 assert.equal((await detail(racer, id)).status, 404);
});

it('two owners demoting each other at once: one change lands, the other is refused, and an owner remains', async () => {
 const first = await signIn('chat-owner-a', 'Ann Able'), second = await signIn('chat-owner-b', 'Ben Baker');
 const shop = (await json<{ id: string }>(request('POST', '/v1/organisations', first, { name: 'Two owners' }), 201)).id;
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${shop}, ${second.user.id}, 'owner')`;
 const results = await Promise.all([
  request('PATCH', `${base(shop)}/members/${second.user.id}`, first, { role: 'admin' }),
  request('PATCH', `${base(shop)}/members/${first.user.id}`, second, { role: 'admin' }),
 ]);
 // The loser re-checks under the locks and finds itself an admin, which cannot change an owner.
 assert.deepEqual(results.map(r => r.status).sort(), [200, 403]);
 assert.equal((await db.owner`select 1 from memberships where organisation_id = ${shop} and role = 'owner' and status = 'active'`).length, 1);
 // The remaining sole owner cannot demote or remove themselves.
 const sole = (await db.owner<{ userId: string }[]>`select user_id from memberships where organisation_id = ${shop} and role = 'owner'`)[0]!.userId;
 const soleOwner = sole === first.user.id ? first : second;
 assert.equal((await json<Failure>(request('PATCH', `${base(shop)}/members/${sole}`, soleOwner, { role: 'admin' }), 400)).code, 'last_owner');
 assert.equal((await json<Failure>(request('DELETE', `${base(shop)}/members/${sole}`, soleOwner), 400)).code, 'last_owner');
});

it('the database refuses chat inserts for inaccessible conversations identically, whether or not they exist', async () => {
 const hidden = await newChat(owner, 'Hidden from third');
 const attempt = (conversation: string) => asApp(third, tx => tx`insert into chat_audit_events (organisation_id, conversation_id, actor_id, action, subject_kind, subject_id, personal, detail)
  values (${org}, ${conversation}, ${third.user.id}, 'chat.star_set', 'conversation', ${conversation}, true, '{}'::jsonb)`).then(() => 'inserted', (error: { code?: string }) => error.code ?? 'error');
 assert.equal(await attempt(hidden.id), await attempt(randomUUID()));
 assert.notEqual(await attempt(hidden.id), 'inserted');
 const message = (conversation: string) => asApp(third, tx => tx`insert into messages (id, organisation_id, conversation_id, seq, change_seq, author_id, body, sent_body_sha256)
  values (${randomUUID()}, ${org}, ${conversation}, 1, 1, ${third.user.id}, 'x', '\\x00'::bytea)`).then(() => 'inserted', (error: { code?: string }) => error.code ?? 'error');
 assert.equal(await message(hidden.id), await message(randomUUID()));
});

it('a unique violation on a constraint the contract does not name is a 500, never a mapped 409', async () => {
 // Test-only: a partial unique index outside the exact-name mapper, scoped to one fresh conversation so no earlier
 // message can conflict with it. Two different client ids with the same synthetic body then collide on it.
 const chat = await newChat(owner, 'Unknown constraint');
 const body = `unique-probe-${randomUUID()}`;
 const index = `chat_test_unmapped_${randomUUID().replaceAll('-', '')}`;
 await db.owner.unsafe(`create unique index ${index} on messages (body) where conversation_id = '${chat.id}'`);
 const logged: unknown[][] = [];
 const original = console.error;
 console.error = (...args: unknown[]) => { logged.push(args); };
 try {
  await json(send(owner, chat.id, body), 201);
  const collided = await send(owner, chat.id, body);
  assert.equal(collided.status, 500);
  const answer = await collided.text();
  assert.deepEqual(JSON.parse(answer), { ok: false, code: 'internal', error: 'something went wrong on our side' });
  assert.ok(!answer.includes(body) && !answer.includes(index), 'the response names neither the content nor the constraint');
  // The log must not carry the body either. Before the service redacted database errors this failed: the handler
  // logged the raw Postgres error, whose detail reads "Key (body)=(<the message>) already exists".
  assert.equal(logged.length, 1, 'the server logged the unexpected error once');
  const line = inspect(logged[0], { depth: 10, showHidden: true });
  assert.ok(!line.includes(body), 'no message content in the log');
  assert.ok(!line.includes(index) && !/Key \(|duplicate key/.test(line), 'no constraint, detail or driver message in the log');
  assert.match(line, /SQLSTATE 23505/, 'the log keeps the SQLSTATE');
  assert.match(String(logged[0]![0]), /^\[.+\]$/, 'and the request id');
 } finally {
  console.error = original;
  await db.owner.unsafe(`drop index if exists ${index}`);
 }
 const after = (await json<Page>(page(owner, chat.id, 'latest=10')));
 assert.equal(after.conversation.lastSeq, 1, 'the failed send advanced no counter');
 assert.equal(after.messages.length, 1);
});

it('export includes only the exporter’s conversations and says so; deletion leaves chat out of its counts', async () => {
 const lead = await signIn('chat-export-owner', 'Eve Export'), colleague = await signIn('chat-export-colleague', 'Cal Colleague');
 const exportOrg = (await json<{ id: string }>(request('POST', '/v1/organisations', lead, { name: 'Export Brewing' }), 201)).id;
 await join(colleague, 'member', exportOrg);
 const mineId = randomUUID(), theirsId = randomUUID();
 await json(create(lead, { id: mineId, title: 'Mine', participantIds: [], links: [] }, exportOrg), 201);
 await json(create(colleague, { id: theirsId, title: 'Theirs', participantIds: [], links: [] }, exportOrg), 201);
 // PR C personal state: each stars and reads their own conversation; a shared one carries both people's rows.
 const sharedId = randomUUID();
 await json(create(lead, { id: sharedId, title: 'Shared', participantIds: [colleague.user.id], links: [] }, exportOrg), 201);
 const said = await json<Message>(request('POST', `${chats(exportOrg)}/${sharedId}/messages`, colleague, { id: randomUUID(), body: 'Hello' }), 201);
 await json(request('POST', `${chats(exportOrg)}/${sharedId}/pins`, colleague, { messageId: said.id }), 201);
 for (const [person, conversation] of [[lead, mineId], [lead, sharedId], [colleague, theirsId], [colleague, sharedId]] as const) {
  await json(request('POST', `${chats(exportOrg)}/${conversation}/star`, person));
  await json(request('POST', `${chats(exportOrg)}/${conversation}/read`, person, { seq: 1 }));
 }
 const response = await request('GET', `${base(exportOrg)}/export`, lead);
 assert.equal(response.status, 200);
 const lines = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as { notes?: string[]; table?: string; row?: Record<string, unknown> });
 assert.match(lines[0]!.notes!.join(' '), /not a complete chat backup/);
 const conversations = lines.filter(l => l.table === 'conversations').map(l => l.row!.id);
 assert.deepEqual(conversations.sort(), [mineId, sharedId].sort());
 // Stars and read positions: only the exporter's own, even in a conversation both people share.
 for (const table of ['conversation_stars', 'conversation_reads']) {
  const rows = lines.filter(l => l.table === table).map(l => l.row!);
  assert.ok(rows.length > 0 && rows.every(row => (row.userId ?? row.user_id) === lead.user.id), table);
 }
 assert.equal(lines.filter(l => l.table === 'message_pins').length, 1, 'shared pins in the exporter’s conversations are exported');
 assert.ok(!JSON.stringify(lines).includes(theirsId), 'no trace of another member’s conversation, including its audit');
 const deleted = await json<{ rowCounts: Record<string, number> }>(request('DELETE', base(exportOrg), lead, { name: 'Export Brewing' }));
 for (const table of ['conversations', 'conversation_participants', 'conversation_links', 'messages', 'chat_audit_events', 'message_pins', 'conversation_stars', 'conversation_reads'])
  assert.ok(!(table in deleted.rowCounts), table);
 assert.equal((await db.owner`select 1 from conversations where organisation_id = ${exportOrg}`).length, 0, 'the cascade removed every member’s conversations');
});

it('chat writes have their own bounded limit; reads do not count against it', async () => {
 const limited = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
  organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => 1_000) });
 const chat = await newChat(owner, 'Limits');
 for (let i = 0; i < 40; i++) assert.equal((await request('GET', `${chats()}/${chat.id}`, owner, undefined, limited)).status, 200);
 const statuses: number[] = [];
 for (let i = 0; i < 31; i++) statuses.push((await request('POST', `${chats()}/${chat.id}/messages`, owner, { id: randomUUID(), body: `n${i}` }, limited)).status);
 assert.equal(statuses.filter(s => s === 201).length, 30);
 const last = await request('POST', `${chats()}/${chat.id}/messages`, owner, { id: randomUUID(), body: 'over' }, limited);
 assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) >= 1);
 // PR C writes share the same limit; their reads do not.
 for (const [method, path, data] of [['POST', 'star', undefined], ['POST', 'read', { seq: 1 }], ['POST', 'pins', { messageId: randomUUID() }]] as const)
  assert.equal((await request(method, `${chats()}/${chat.id}/${path}`, owner, data, limited)).status, 429, path);
 assert.equal((await request('GET', `${chats()}/${chat.id}/pins`, owner, undefined, limited)).status, 200);
});

// PR C (contract §5, §8, §13, §16): author edits, shared pins, personal stars and read positions. ------------------

const edit = (person: Person, conversation: string, message: string, expectedRevision: number, body: string) =>
 request('PATCH', `${chats()}/${conversation}/messages/${message}`, person, { expectedRevision, body });
const pinIt = (person: Person, conversation: string, messageId: string) => request('POST', `${chats()}/${conversation}/pins`, person, { messageId });
const unpinIt = (person: Person, conversation: string, pinId: string) => request('DELETE', `${chats()}/${conversation}/pins/${pinId}`, person);
const pinsOf = (person: Person, conversation: string) => request('GET', `${chats()}/${conversation}/pins`, person);
const star = (person: Person, conversation: string, on: boolean) => request(on ? 'POST' : 'DELETE', `${chats()}/${conversation}/star`, person);
const read = (person: Person, conversation: string, seq: number) => request('POST', `${chats()}/${conversation}/read`, person, { seq });
const tombstone = (person: Person, conversation: string, message: string, expectedRevision: number) =>
 request('DELETE', `${chats()}/${conversation}/messages/${message}?expectedRevision=${expectedRevision}`, person);
const counters = async (conversation: string) => ({ ...(await db.owner<{ lastSeq: number; lastChange: number; revision: number }[]>`
 select last_seq, last_change, revision from conversations where id = ${conversation}`)[0]! });
const personalAudit = (person: Person, conversation: string) => asApp(person, tx => tx<{ action: string; actorId: string }[]>`
 select action, actor_id from chat_audit_events where conversation_id = ${conversation} and personal order by created_at, id`);

it('authors edit their own messages; moderators cannot; stale, deleted and unchanged edits write nothing', async () => {
 const id = randomUUID();
 const body = { id, title: 'Edits', participantIds: [member.user.id, admin.user.id], links: [] };
 await json(create(owner, body), 201);
 const messageId = randomUUID();
 const sent = await json<Message>(send(member, id, 'First draft', messageId), 201);
 const before = await counters(id);
 const edited = await json<Message>(edit(member, id, messageId, 1, '  Second draft  '));
 assert.equal(edited.body, 'Second draft'); assert.equal(edited.revision, 2); assert.ok(edited.editedAt);
 assert.equal(edited.seq, sent.seq, 'an edit keeps its place');
 assert.equal(edited.changeSeq, before.lastChange + 1);
 assert.deepEqual(await counters(id), { ...before, lastChange: before.lastChange + 1 }, 'an edit moves only last_change');

 // Nobody else edits: not an admin participant (a moderator), not the owner.
 for (const other of [admin, owner]) assert.equal((await edit(other, id, messageId, 2, 'Rewritten')).status, 403);
 assert.equal((await json<Page>(page(owner, id, 'latest=1'))).messages[0]!.body, 'Second draft');
 assert.equal((await json<Failure>(edit(member, id, messageId, 1, 'Late'), 409)).code, 'stale_revision');
 assert.equal((await json<Failure>(edit(member, id, messageId, 2, '   '), 400)).code, 'invalid_body');
 // The same body at the current revision is a no-op: no write, no audit row.
 const trail = (await chatAudit(id)).length, now = await counters(id);
 const unchanged = await json<Message>(edit(member, id, messageId, 2, 'Second draft '));
 assert.equal(unchanged.revision, 2); assert.equal(unchanged.changeSeq, edited.changeSeq);
 assert.deepEqual(await counters(id), now); assert.equal((await chatAudit(id)).length, trail);

 // Retries after an edit: the send returns the current (edited) message; the create still matches.
 const retried = await json<Message>(send(member, id, 'First draft', messageId), 200);
 assert.equal(retried.body, 'Second draft'); assert.equal(retried.revision, 2);
 assert.equal((await json<Detail>(create(owner, body), 200)).id, id);
 assert.deepEqual(await counters(id), now, 'neither retry wrote anything');

 // A tombstone cannot be edited, even by its author.
 await json(tombstone(member, id, messageId, 2));
 assert.equal((await edit(member, id, messageId, 3, 'Back again')).status, 404);
 const audit = await chatAudit(id);
 assert.equal(audit.filter(a => a.action === 'chat.message_edited').length, 1);
 assert.ok(!JSON.stringify(audit).includes('draft'), 'the edit audit carries ids and counters only');
});

it('any participant pins and unpins; duplicates, tombstones and hidden messages are refused', async () => {
 const chat = await newChat(owner, 'Pins', [member]), other = await newChat(owner, 'Elsewhere');
 const [one, two] = [await json<Message>(send(member, chat.id, 'Pin me'), 201), await json<Message>(send(owner, chat.id, 'Delete me'), 201)];
 const elsewhere = await json<Message>(send(owner, other.id, 'Not here'), 201);
 const before = await counters(chat.id);
 const pinned = await json<Pin>(pinIt(member, chat.id, one.id), 201);
 assert.equal(pinned.messageId, one.id); assert.equal(pinned.pinnedBy, member.user.id); assert.equal(pinned.unpinnedAt, null);
 assert.equal(pinned.changeSeq, before.lastChange + 1);
 assert.deepEqual(await counters(chat.id), { ...before, lastChange: before.lastChange + 1 }, 'a pin moves only last_change');
 assert.deepEqual((await json<{ pins: Pin[] }>(pinsOf(owner, chat.id))).pins.map(p => p.id), [pinned.id]);
 // Pins have server ids: a retried or second pin of the same message is refused, and nothing is written.
 assert.equal((await json<Failure>(pinIt(owner, chat.id, one.id), 409)).code, 'message_already_pinned');
 assert.equal((await counters(chat.id)).lastChange, before.lastChange + 1);
 // Any participant unpins, once.
 const unpinned = await json<Pin>(unpinIt(owner, chat.id, pinned.id));
 assert.equal(unpinned.unpinnedBy, owner.user.id); assert.ok(unpinned.unpinnedAt); assert.equal(unpinned.changeSeq, before.lastChange + 2);
 assert.equal((await unpinIt(owner, chat.id, pinned.id)).status, 404);
 assert.deepEqual((await json<{ pins: Pin[] }>(pinsOf(member, chat.id))).pins, []);
 await json(pinIt(owner, chat.id, one.id), 201);
 // A visible tombstone is its own 409; a message that is missing, or in another conversation, is the usual 404.
 await json(tombstone(owner, chat.id, two.id, 1));
 assert.equal((await json<Failure>(pinIt(member, chat.id, two.id), 409)).code, 'message_deleted');
 assert.equal((await pinIt(member, chat.id, randomUUID())).status, 404);
 assert.equal((await pinIt(owner, chat.id, elsewhere.id)).status, 404);
 // Non-participants see and change nothing.
 for (const response of [pinsOf(third, chat.id), pinIt(third, chat.id, one.id), unpinIt(third, chat.id, pinned.id), star(third, chat.id, true), read(third, chat.id, 1),
  edit(third, chat.id, one.id, 1, 'x')]) assert.equal((await response).status, 404);
 assert.deepEqual((await chatAudit(chat.id)).map(a => a.action).filter(a => a.startsWith('chat.pin')), ['chat.pin_added', 'chat.pin_removed', 'chat.pin_added']);
});

it('a conversation holds at most fifty live pins, including under concurrent pins', async () => {
 const chat = await newChat(owner, 'Pinboard', [member]);
 const sent: Message[] = [];
 for (let i = 0; i < 51; i++) sent.push(await json<Message>(send(owner, chat.id, `Notice ${i}`), 201));
 for (let i = 0; i < 48; i++) await json(pinIt(owner, chat.id, sent[i]!.id), 201);
 await json(pinIt(owner, chat.id, sent[48]!.id), 201);
 // At 49: two people pin different messages at once; the conversation lock lets exactly one reach 50.
 const race = await Promise.all([pinIt(owner, chat.id, sent[49]!.id), pinIt(member, chat.id, sent[50]!.id)]);
 assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
 assert.equal(((await race.find(r => r.status === 409)!.json()) as Failure).code, 'pin_limit');
 const board = await json<{ pins: Pin[] }>(pinsOf(member, chat.id));
 assert.equal(board.pins.length, 50, 'every live pin, in one read');
 assert.deepEqual(board.pins.map(p => p.changeSeq), [...board.pins.map(p => p.changeSeq)].sort((a, b) => a - b));
 const loser = race.findIndex(r => r.status === 409) === 0 ? sent[49]! : sent[50]!;
 assert.equal((await json<Failure>(pinIt(owner, chat.id, loser.id), 409)).code, 'pin_limit');
 // Unpinning makes room again.
 await json(unpinIt(member, chat.id, board.pins[0]!.id));
 await json(pinIt(owner, chat.id, loser.id), 201);
});

it('deleting a pinned message unpins it atomically, numbered after the tombstone, with one audit row', async () => {
 const chat = await newChat(owner, 'Delete pinned', [member]);
 const message = await json<Message>(send(member, chat.id, 'Pinned then deleted'), 201);
 const pin = await json<Pin>(pinIt(owner, chat.id, message.id), 201);
 const mark = (await counters(chat.id)).lastChange;
 const auditBefore = (await chatAudit(chat.id)).length;
 const deleted = await json<Message>(tombstone(member, chat.id, message.id, 1));
 assert.equal(deleted.changeSeq, mark + 1);
 assert.deepEqual((await json<{ pins: Pin[] }>(pinsOf(owner, chat.id))).pins, [], 'no live pin on a tombstone');
 // Paged one change at a time, the tombstone arrives first and the unpin after it.
 const first = await json<Changes>(changes(owner, chat.id, `after=${mark}&limit=1`));
 assert.equal(first.complete, false); assert.equal(first.next, mark + 1);
 assert.equal(messageOf(first.changes[0]!).body, null);
 const second = await json<Changes>(changes(owner, chat.id, `after=${first.next}&limit=1`));
 assert.equal(second.complete, true);
 const unpin = second.changes[0]!;
 assert.equal(unpin.kind, 'pin'); assert.equal(unpin.changeSeq, mark + 2);
 assert.equal(unpin.kind === 'pin' ? unpin.pin.id : null, pin.id);
 assert.ok(unpin.kind === 'pin' && unpin.pin.unpinnedAt);
 // One request, one audit row: chat.message_deleted naming the pin, no separate chat.pin_removed.
 const written = (await chatAudit(chat.id)).slice(auditBefore);
 assert.deepEqual(written.map(a => a.action), ['chat.message_deleted']);
 assert.equal(written[0]!.detail.unpinnedPinId, pin.id);
});

it('a failure between the tombstone and the unpin rolls the whole DELETE back, and a retry then succeeds', async () => {
 const chat = await newChat(owner, 'Rollback', [member]);
 const text = `Stays live ${randomUUID()}`;
 const message = await json<Message>(send(member, chat.id, text), 201);
 const pin = await json<Pin>(pinIt(member, chat.id, message.id), 201);
 const before = await counters(chat.id), auditBefore = await chatAudit(chat.id);
 // Test-only, owner-installed: a BEFORE UPDATE trigger on this one fixture pin that refuses the unpin, so the real
 // DELETE fails after its tombstone was written. If the service ever committed the tombstone separately from the
 // unpin, the message would stay deleted here. No production code is involved.
 const name = `chat_test_refuse_unpin_${randomUUID().replaceAll('-', '')}`;
 await db.owner.unsafe(`create function ${name}() returns trigger language plpgsql as $$
  begin
   if old.unpinned_at is null and new.unpinned_at is not null then raise exception 'refused by the test fixture'; end if;
   return new;
  end $$`);
 const logged: unknown[][] = [];
 const original = console.error;
 try {
  await db.owner.unsafe(`create trigger ${name} before update on message_pins for each row when (old.id = '${pin.id}') execute function ${name}()`);
  console.error = (...args: unknown[]) => { logged.push(args); };
  const failed = await tombstone(member, chat.id, message.id, 1);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, code: 'internal', error: 'something went wrong on our side' });
  assert.equal(logged.length, 1, 'the server logged the unexpected error once');
  const line = inspect(logged[0], { depth: 10, showHidden: true });
  assert.ok(!line.includes(text), 'no message content in the log');
  assert.ok(!line.includes('refused by the test fixture') && !line.includes(name), 'no driver message or trigger name in the log');
  assert.match(line, /SQLSTATE P0001/, 'the log keeps the SQLSTATE');
 } finally {
  console.error = original;
  await db.owner.unsafe(`drop trigger if exists ${name} on message_pins`);
  await db.owner.unsafe(`drop function if exists ${name}()`);
 }
 // Nothing of the DELETE survived: counters, the message, the pin and the audit trail are as they were.
 assert.deepEqual(await counters(chat.id), before);
 const live = (await json<Page>(page(owner, chat.id, 'latest=1'))).messages[0]!;
 assert.equal(live.body, text); assert.equal(live.deletedAt, null); assert.equal(live.revision, 1);
 assert.deepEqual((await json<{ pins: Pin[] }>(pinsOf(owner, chat.id))).pins.map(p => [p.id, p.unpinnedAt]), [[pin.id, null]]);
 assert.equal((await chatAudit(chat.id)).length, auditBefore.length);
 // With the fixture gone, the same request succeeds: tombstone then unpin, one audit row naming the pin.
 const deleted = await json<Message>(tombstone(member, chat.id, message.id, 1));
 assert.equal(deleted.body, null); assert.equal(deleted.changeSeq, before.lastChange + 1);
 assert.deepEqual((await json<{ pins: Pin[] }>(pinsOf(owner, chat.id))).pins, []);
 assert.deepEqual(await counters(chat.id), { ...before, lastChange: before.lastChange + 2 });
 const written = (await chatAudit(chat.id)).slice(auditBefore.length);
 assert.deepEqual(written.map(a => a.action), ['chat.message_deleted']);
 assert.equal(written[0]!.detail.unpinnedPinId, pin.id);
});

it('the change feed converges across edits and pins made between pages', async () => {
 const chat = await newChat(owner, 'Converge', [member]);
 const sent: Message[] = [];
 for (let i = 0; i < 4; i++) sent.push(await json<Message>(send(i % 2 ? owner : member, chat.id, `Line ${i}`), 201));
 const seen = new Map<string, Change>();
 const upsert = (change: Change) => {
  const key = change.kind === 'message' ? `message:${change.message.id}` : `pin:${change.pin.id}`;
  const known = seen.get(key); if (!known || known.changeSeq < change.changeSeq) seen.set(key, change);
 };
 const firstPage = await json<Changes>(changes(owner, chat.id, 'after=0&limit=2'));
 firstPage.changes.forEach(upsert);
 // Between pages: the first line is edited (it reappears at a later number) and the third is pinned.
 await json(edit(member, chat.id, sent[0]!.id, 1, 'Line 0, corrected'));
 await json(pinIt(owner, chat.id, sent[2]!.id), 201);
 let cursor = firstPage.next, complete = firstPage.complete, rounds = 0;
 while (!complete && rounds++ < 20) {
  const batch = await json<Changes>(changes(owner, chat.id, `after=${cursor}&limit=2`));
  batch.changes.forEach(upsert); assert.ok(batch.next >= cursor); cursor = batch.next; complete = batch.complete;
 }
 const messages = [...seen.values()].filter(c => c.kind === 'message').map(messageOf).sort((a, b) => a.seq - b.seq);
 assert.deepEqual(messages, (await json<Page>(page(owner, chat.id, 'after=0&limit=100'))).messages, 'the client copy equals the server');
 assert.equal(messages[0]!.body, 'Line 0, corrected');
 const pins = [...seen.values()].filter(c => c.kind === 'pin');
 assert.equal(pins.length, 1);
 assert.equal(cursor, (await counters(chat.id)).lastChange);
});

it('stars are personal and idempotent; only changes are audited, and only the actor sees those rows', async () => {
 const chat = await newChat(owner, 'Stars', [member]);
 assert.deepEqual(await json(star(member, chat.id, true)), { starred: true });
 assert.deepEqual(await json(star(member, chat.id, true)), { starred: true });
 assert.equal((await json<Detail>(detail(member, chat.id))).starred, true);
 assert.equal((await json<Detail>(detail(owner, chat.id))).starred, false, 'a star is the starring person’s alone');
 const listed = await json<{ conversations: Detail[] }>(request('GET', chats(), member));
 assert.equal(listed.conversations.find(c => c.id === chat.id)!.starred, true);
 await json(star(member, chat.id, false)); await json(star(member, chat.id, false));
 assert.deepEqual((await personalAudit(member, chat.id)).map(a => a.action), ['chat.star_set', 'chat.star_cleared'], 'no-ops write nothing');
 assert.equal((await personalAudit(owner, chat.id)).length, 0, 'another participant sees none of it');
 const before = await counters(chat.id);
 await json(star(member, chat.id, true));
 assert.deepEqual(await counters(chat.id), before, 'a star moves no counter or revision');
 // Hidden while not participating, back after an explicit re-add.
 await json(removePerson(member, chat.id, member, before.revision));
 assert.equal((await star(member, chat.id, false)).status, 404);
 await json(addPeople(owner, chat.id, before.revision + 1, [member]));
 assert.equal((await json<Detail>(detail(member, chat.id))).starred, true);
});

it('read positions start at the participation baseline, never move back, and bound unread counts', async () => {
 const reader = await signIn('chat-reader', 'Rita Reader'), late = await signIn('chat-late', 'Lars Late');
 await join(reader); await join(late);
 const chat = await newChat(owner, 'Reading', [reader]);
 for (let i = 0; i < 3; i++) await json(send(owner, chat.id, `Update ${i}`), 201);
 let seen = await json<Detail>(detail(reader, chat.id));
 assert.deepEqual([seen.lastReadSeq, seen.unread], [0, 3], 'created at 0: everything since is unread');
 assert.equal((await json<Detail>(detail(owner, chat.id))).unread, 0, 'your own messages are never unread');
 assert.deepEqual(await json(read(reader, chat.id, 2)), { lastReadSeq: 2, unread: 1 });
 assert.deepEqual(await json(read(reader, chat.id, 1)), { lastReadSeq: 2, unread: 1 }, 'never back');
 assert.deepEqual(await json(read(reader, chat.id, 999)), { lastReadSeq: 3, unread: 0 }, 'clamped to last_seq');
 assert.deepEqual(await json(read(reader, chat.id, 3)), { lastReadSeq: 3, unread: 0 });
 assert.deepEqual((await personalAudit(reader, chat.id)).map(a => a.action), ['chat.read_advanced', 'chat.read_advanced'], 'only advances are audited');
 assert.equal((await personalAudit(owner, chat.id)).length, 0);
 const before = await counters(chat.id);
 // Deleted messages are not unread.
 const gone = await json<Message>(send(owner, chat.id, 'Retracted'), 201);
 assert.equal((await json<Detail>(detail(reader, chat.id))).unread, 1);
 await json(tombstone(owner, chat.id, gone.id, 1));
 assert.equal((await json<Detail>(detail(reader, chat.id))).unread, 0);

 // A later add starts at that moment's last_seq, and it stays fixed: with no private read row, new messages count.
 const at = (await counters(chat.id)).lastSeq;
 await json(addPeople(owner, chat.id, before.revision, [late]));
 seen = await json<Detail>(detail(late, chat.id));
 assert.deepEqual([seen.lastReadSeq, seen.unread], [at, 0], 'no history flood on joining');
 await json(send(owner, chat.id, 'After you joined'), 201); await json(send(reader, chat.id, 'Welcome'), 201);
 seen = await json<Detail>(detail(late, chat.id));
 assert.deepEqual([seen.lastReadSeq, seen.unread], [at, 2], 'the baseline did not follow last_seq');
 assert.equal((await db.owner`select 1 from conversation_reads where conversation_id = ${chat.id} and user_id = ${late.user.id}`).length, 0, 'no private read row was written for them');

 // Re-add resets the baseline, so an older private read row cannot bring back old unread messages.
 await json(read(late, chat.id, at + 1));
 const revision = (await counters(chat.id)).revision;
 await json(removePerson(late, chat.id, late, revision));
 for (let i = 0; i < 3; i++) await json(send(owner, chat.id, `While away ${i}`), 201);
 await json(addPeople(owner, chat.id, revision + 1, [late]));
 seen = await json<Detail>(detail(late, chat.id));
 assert.deepEqual([seen.lastReadSeq, seen.unread], [(await counters(chat.id)).lastSeq, 0]);

 // A former member's message still counts as someone else's.
 const leaver = await signIn('chat-read-leaver', 'Lou Leaver'); await join(leaver);
 const revisionNow = (await counters(chat.id)).revision;
 await json(addPeople(owner, chat.id, revisionNow, [leaver]));
 await json(send(leaver, chat.id, 'Last words'), 201);
 await db.owner`delete from users where id = ${leaver.user.id}`;
 assert.equal((await json<Page>(page(owner, chat.id, 'latest=1'))).messages[0]!.authorId, null);
 assert.equal((await json<Detail>(detail(late, chat.id))).unread, 1);
});

it('unread counts stop at 51, in the list, detail and work-to-chat', async () => {
 const task = await makeTask('Busy thread');
 const chat = await newChat(owner, 'Flooded', [member], [{ kind: 'task', targetId: task }]);
 for (let i = 0; i < 53; i++) await json(send(owner, chat.id, `Flood ${i}`), 201);
 assert.equal((await json<Detail>(detail(member, chat.id))).unread, 51);
 assert.equal((await json<{ conversations: Detail[] }>(request('GET', chats(), member))).conversations.find(c => c.id === chat.id)!.unread, 51);
 assert.equal((await json<{ conversations: Detail[] }>(request('GET', `${base()}/tasks/${task}/conversations`, member))).conversations[0]!.unread, 51);
 assert.deepEqual(await json(read(member, chat.id, 1)), { lastReadSeq: 1, unread: 51 });
 assert.deepEqual(await json(read(member, chat.id, 50)), { lastReadSeq: 50, unread: 3 });
});

// Web read API (docs/plans/linked-chat-web-2026-09.md §3, A1–A4). -----------------------------------------------

type Listed = Detail & {
 latest: { seq: number; authorName: string | null; excerpt: string | null; deleted: boolean } | null;
 linkSummary: { first: { kind: 'task' | 'project'; targetId: string; title: string } | null; count: number };
};
type ListPage = { conversations: Listed[]; nextCursor: string | null };
const listIn = (person: Person, query: string) => request('GET', `${chats()}?${query}`, person);
/** Every conversation in one view, one per page, checking that no page repeats or skips one. */
async function everyPage(person: Person, view: string): Promise<Listed[]> {
 const seen: Listed[] = []; let cursor: string | null = null;
 for (let rounds = 0; rounds < 50; rounds++) {
  const listed: ListPage = await json<ListPage>(listIn(person, `${view}${view ? '&' : ''}limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`));
  seen.push(...listed.conversations);
  cursor = listed.nextCursor;
  if (cursor === null) break;
 }
 assert.equal(cursor, null, `${view}: paging ends`);
 assert.equal(new Set(seen.map(c => c.id)).size, seen.length, `${view}: no conversation twice`);
 return seen;
}
/** One conversation's row in a view. It must have the newest activity's page (the first 50): the people used here are
 *  in many conversations by now, and a conversation just written to is always on the first page. */
async function rowIn(person: Person, view: string, id: string): Promise<Listed> {
 const found = (await json<ListPage>(listIn(person, `${view}${view ? '&' : ''}limit=50`))).conversations.find(c => c.id === id);
 assert.ok(found, `${id} in ${view || 'the default view'}`);
 return found;
}

it('views compose filter and linked before pagination, each paging on its own, never showing another’s conversations', async () => {
 const viewer = await signIn('chat-viewer', 'Vic Viewer'); await join(viewer);
 const task = await makeTask('View link');
 // Five of the viewer's conversations, oldest first, and one they are not in.
 const workUnread = await newChat(viewer, 'Work, starred, unread', [owner], [{ kind: 'task', targetId: task }]);
 const workRead = await newChat(viewer, 'Work, read', [owner], [{ kind: 'task', targetId: task }]);
 const teamUnread = await newChat(viewer, 'Team, unread', [owner]);
 const teamStarred = await newChat(viewer, 'Team, starred', [owner]);
 const teamQuiet = await newChat(viewer, 'Team, quiet', [owner]);
 const hidden = await newChat(owner, 'Not the viewer’s', [member], [{ kind: 'task', targetId: task }]);
 await json(send(owner, hidden.id, 'Private to others'), 201);
 await json(send(owner, workUnread.id, 'For the viewer'), 201);
 await json(send(owner, workRead.id, 'Already seen'), 201); await json(read(viewer, workRead.id, 1));
 await json(send(owner, teamUnread.id, 'Also for the viewer'), 201);
 await json(send(viewer, teamStarred.id, 'My own words are never unread'), 201);
 await json(star(viewer, workUnread.id, true)); await json(star(viewer, teamStarred.id, true));
 const ids = (rows: Listed[]) => rows.map(c => c.id).sort();
 const expected: Record<string, string[]> = {
  '': [workUnread.id, workRead.id, teamUnread.id, teamStarred.id, teamQuiet.id],
  'filter=all': [workUnread.id, workRead.id, teamUnread.id, teamStarred.id, teamQuiet.id],
  'filter=unread': [workUnread.id, teamUnread.id],
  'filter=starred': [workUnread.id, teamStarred.id],
  'linked=true': [workUnread.id, workRead.id],
  'linked=false': [teamUnread.id, teamStarred.id, teamQuiet.id],
  'filter=unread&linked=true': [workUnread.id],
  'filter=unread&linked=false': [teamUnread.id],
  'filter=starred&linked=true': [workUnread.id],
  'filter=starred&linked=false': [teamStarred.id],
 };
 for (const [view, want] of Object.entries(expected)) {
  const rows = await everyPage(viewer, view);
  assert.deepEqual(ids(rows), [...want].sort(), view || 'default');
  assert.ok(!rows.some(c => c.id === hidden.id), `${view}: never someone else’s conversation`);
  if (view.includes('unread')) assert.ok(rows.every(c => c.unread > 0), `${view}: EXISTS agrees with the capped count`);
  if (view.includes('starred')) assert.ok(rows.every(c => c.starred), view);
 }
 // Newest activity first within a view.
 assert.deepEqual((await everyPage(viewer, 'linked=false')).map(c => c.id), [teamStarred.id, teamUnread.id, teamQuiet.id]);
 // The unread view agrees with every row the default view marks unread.
 assert.deepEqual(ids((await everyPage(viewer, '')).filter(c => c.unread > 0)), ids(await everyPage(viewer, 'filter=unread')));
});

it('a cursor belongs to its view; the legacy pair is accepted only for the default view; malformed queries are 400', async () => {
 const pager = await signIn('chat-cursor', 'Cora Cursor'); await join(pager);
 for (let i = 0; i < 3; i++) { const chat = await newChat(pager, `Cursor ${i}`, [owner]); await json(send(owner, chat.id, 'unread'), 201); }
 const first = await json<ListPage>(listIn(pager, 'filter=unread&limit=1'));
 assert.ok(first.nextCursor);
 const cursor = encodeURIComponent(first.nextCursor!);
 assert.equal((await json<ListPage>(listIn(pager, `filter=unread&limit=1&cursor=${cursor}`))).conversations.length, 1, 'its own view pages on');
 for (const other of ['filter=starred', 'filter=unread&linked=true', 'filter=unread&linked=false', '', 'filter=all'])
  assert.equal((await json<Failure>(listIn(pager, `${other}${other ? '&' : ''}cursor=${cursor}`), 400)).code, 'invalid_request', `unread cursor used for "${other}"`);
 // The legacy pair (activity key, id): only the default view, and only when it is otherwise valid.
 const legacy = encodeURIComponent(encodeCursor('2999-01-01T00:00:00.000000Z', randomUUID()));
 assert.equal((await listIn(pager, `cursor=${legacy}`)).status, 200);
 assert.equal((await listIn(pager, `filter=all&cursor=${legacy}`)).status, 200, 'filter=all with linked omitted is the default view');
 for (const view of ['filter=unread', 'filter=starred', 'linked=true', 'linked=false', 'filter=all&linked=true'])
  assert.equal((await json<Failure>(listIn(pager, `${view}&cursor=${legacy}`), 400)).code, 'invalid_request', view);
 // Crafted cursors and malformed queries.
 const crafted = (value: unknown) => encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64url'));
 const key = '2999-01-01T00:00:00.000000Z', id = randomUUID();
 for (const bad of [crafted([key, id, 'unread', 'any', 'extra']), crafted([key, id, 'unread']), crafted([key, id, 'everything', 'any']), crafted([key, id, 'unread', 'maybe']),
  crafted([key, 'not-a-uuid', 'unread', 'any']), crafted(['garbage', id, 'unread', 'any']), 'x'])
  assert.equal((await json<Failure>(listIn(pager, `filter=unread&cursor=${bad}`), 400)).code, 'invalid_request', bad);
 for (const query of ['filter=bogus', 'linked=maybe', 'linked=', 'filter=unread&filter=starred', 'linked=true&linked=false', 'view=all', 'limit=0', 'limit=51'])
  assert.equal((await listIn(pager, query)).status, 400, query);
});

it('list and work-to-chat rows carry the latest message excerpt and the first link with a count; detail does not', async () => {
 const task = await makeTask('Excerpt task'), project = await makeProject('Excerpt project');
 const chat = await newChat(owner, 'Excerpts', [member], [{ kind: 'task', targetId: task }]);
 const row = () => rowIn(owner, 'linked=true', chat.id);
 let listed = await row();
 assert.equal(listed.latest, null, 'no messages yet');
 assert.deepEqual(listed.linkSummary, { first: { kind: 'task', targetId: task, title: 'Excerpt task' }, count: 1 });
 // A link added later is counted but is not first: first is by created_at, id.
 await json(request('POST', `${chats()}/${chat.id}/links`, owner, { expectedRevision: 1, kind: 'project', targetId: project }), 201);
 listed = await row();
 assert.deepEqual(listed.linkSummary, { first: { kind: 'task', targetId: task, title: 'Excerpt task' }, count: 2 });
 // The excerpt is cut in SQL at 160 code points, astral characters included.
 const long = await json<Message>(send(member, chat.id, '🍺'.repeat(4000)), 201);
 listed = await row();
 assert.deepEqual(listed.latest, { seq: long.seq, authorName: 'Mia Member', excerpt: '🍺'.repeat(160), deleted: false });
 assert.equal([...listed.latest!.excerpt!].length, 160);
 // A tombstone has no excerpt.
 await json(tombstone(member, chat.id, long.id, 1));
 listed = await row();
 assert.deepEqual(listed.latest, { seq: long.seq, authorName: 'Mia Member', excerpt: null, deleted: true });
 // Work to chat carries the same row; detail keeps its full links array and gains neither field.
 const fromWork = (await json<{ conversations: Listed[] }>(request('GET', `${base()}/tasks/${task}/conversations`, owner))).conversations.find(c => c.id === chat.id)!;
 assert.deepEqual([fromWork.latest, fromWork.linkSummary], [listed.latest, listed.linkSummary]);
 const full = await json<Detail>(detail(owner, chat.id));
 assert.equal(full.links.length, 2);
 assert.ok(!('latest' in full) && !('linkSummary' in full));
 // An empty conversation with no links.
 const quiet = await newChat(owner, 'No links');
 const quietRow = await rowIn(owner, 'linked=false', quiet.id);
 assert.deepEqual([quietRow.latest, quietRow.linkSummary], [null, { first: null, count: 0 }]);
});

it('author names: kept after leaving or removal from the organisation, null only when the attribution was deleted', async () => {
 const people = [await signIn('chat-name-left', 'Lena Left'), await signIn('chat-name-removed', 'Remy Removed'),
  await signIn('chat-name-account', 'Ada Account'), await signIn('chat-name-row', 'Rowan Row')];
 for (const person of people) await join(person);
 const [left, removed, account, row] = people as [Person, Person, Person, Person];
 const chat = await newChat(owner, 'Names', people);
 const sent: Message[] = [];
 for (const person of people) sent.push(await json<Message>(send(person, chat.id, `From ${person.user.id}`), 201));
 assert.deepEqual(sent.map(m => m.authorName), ['Lena Left', 'Remy Removed', 'Ada Account', 'Rowan Row'], 'writes return the name too');
 await json(pinIt(owner, chat.id, sent[2]!.id), 201);
 await json(removePerson(left, chat.id, left, (await counters(chat.id)).revision)); // leaves the conversation
 await json(request('DELETE', `${base()}/members/${removed.user.id}`, owner)); // membership status becomes removed
 await db.owner`delete from users where id = ${account.user.id}`; // account deletion
 await db.owner`delete from memberships where organisation_id = ${org} and user_id = ${row.user.id}`; // membership row deletion
 const names = (messages: { id: string; authorName: string | null }[]) => sent.map(m => messages.find(x => x.id === m.id)?.authorName);
 const want = ['Lena Left', 'Remy Removed', null, null];
 assert.deepEqual(names((await json<Page>(page(owner, chat.id, 'latest=10'))).messages as (Message & { authorName: string | null })[]), want);
 const feed = (await json<Changes>(changes(owner, chat.id, 'after=0'))).changes.filter(c => c.kind === 'message').map(messageOf);
 assert.deepEqual(names(feed as (Message & { authorName: string | null })[]), want, 'the change feed carries the same names');
 const pinned = (await json<{ pins: (Pin & { message: Message & { authorName: string | null } })[] }>(pinsOf(owner, chat.id))).pins;
 assert.equal(pinned[0]!.message.authorName, null, 'a pinned message whose author account was deleted');
 assert.equal((await rowIn(owner, '', chat.id)).latest!.authorName, null, 'the list excerpt too');
});

it('GET pins returns each pin’s original message from the same snapshot, even outside the latest messages', async () => {
 const chat = await newChat(owner, 'Old pin', [member]);
 const first = await json<Message>(send(member, chat.id, 'The original decision'), 201);
 for (let i = 0; i < 8; i++) await json(send(owner, chat.id, `Later ${i}`), 201);
 await json(edit(member, chat.id, first.id, 1, 'The original decision, clarified'));
 const pin = await json<Pin>(pinIt(owner, chat.id, first.id), 201);
 const latest = await json<Page>(page(owner, chat.id, 'latest=6'));
 assert.ok(!latest.messages.some(m => m.id === first.id), 'the pinned message is outside the latest six');
 const board = await json<{ conversation: { lastChange: number }; pins: (Pin & { message: Message & { authorName: string | null } })[] }>(pinsOf(member, chat.id));
 assert.equal(board.pins.length, 1);
 const hydrated = board.pins[0]!;
 assert.equal(hydrated.id, pin.id);
 assert.equal(hydrated.message.id, first.id); assert.equal(hydrated.message.seq, 1);
 assert.equal(hydrated.message.body, 'The original decision, clarified'); assert.equal(hydrated.message.revision, 2);
 assert.equal(hydrated.message.authorName, 'Mia Member'); assert.equal(hydrated.message.deletedAt, null);
 assert.equal(board.conversation.lastChange, (await counters(chat.id)).lastChange, 'one snapshot: pins and messages as of this counter');
 // Pin, unpin and change-feed pin objects keep their plain shape.
 assert.ok(!('message' in pin));
 const pinChange = (await json<Changes>(changes(owner, chat.id, 'after=0'))).changes.find(c => c.kind === 'pin')!;
 assert.ok(pinChange.kind === 'pin' && !('message' in pinChange.pin));
 assert.equal((await pinsOf(third, chat.id)).status, 404, 'still private');
});
