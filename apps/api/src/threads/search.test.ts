import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import type { IdentityProvider } from '../auth/google.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { RateLimiter } from '../ratelimit.ts';
import { searchTerms } from './service.ts';

// H4 (docs/plans/tags-series-search-2026-10.md §2, §4): search in the thread list, archived tags without headings, tag
// thread counts and "Repeat this task". Real Postgres, as the runtime role; each test runs in its own organisation.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>, commitments: CommitmentsService;
type Person = { token: string; user: { id: string } };
type Chip = { id: string; name: string };
type Match = { kind: 'title' | 'message'; excerpt: string; authorName: string | null };
type Row = { id: string; kind: string; title: string; record: { kind: string; id: string } | null; lastMessage: { authorName: string | null; excerpt: string } | null;
 needsYou: boolean; tags: Chip[]; match: Match };
type Search = { filter: string; q: string; available: boolean; threads: Row[] };
type List = { threads: Omit<Row, 'match'>[]; groups: { key: string; label: string; threads: number }[] };
type Detail = { thread: { id: string; revision: number }; card: { fold: Record<string, unknown> }; tags: Chip[] };
type Failure = { code: string };
type Series = { id: string; title: string; body: string; ownerId: string | null; tagIds: string[]; recurrence: string; anchor: string; revision: number; changeSetId: string };
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
async function business(name: string) {
 const n = ++people;
 const owner = await signIn(`search-owner-${n}`, `Olive ${n}`), member = await signIn(`search-member-${n}`, `Mia ${n}`), other = await signIn(`search-other-${n}`, `Otto ${n}`);
 const org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name }), 201)).id;
 for (const person of [member, other]) await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${person.user.id}, 'member')`;
 const base = `/v1/organisations/${org}`, threads = `${base}/threads`;
 const b = {
  org, owner, member, other, base, threads,
  search: (person: Person, q: string, extra = '') => json<Search>(request('GET', `${threads}?q=${encodeURIComponent(q)}${extra}`, person)),
  searchRaw: (person: Person, q: string, extra = '') => request('GET', `${threads}?q=${encodeURIComponent(q)}${extra}`, person),
  list: (person: Person, query = '') => json<List>(request('GET', `${threads}${query ? `?${query}` : ''}`, person)),
  topic: async (person: Person, body: string) => (await json<Detail>(request('POST', threads, person, { id: randomUUID(), kind: 'topic', message: { id: randomUUID(), body } }), 201)).thread.id,
  private: async (person: Person, title: string, participantIds: string[], body: string) => (await json<Detail>(request('POST', threads, person,
   { id: randomUUID(), kind: 'private', title, participantIds, message: { id: randomUUID(), body } }), 201)).thread.id,
  send: (person: Person, thread: string, body: string) => json<{ id: string; revision: number }>(request('POST', `${threads}/${thread}/messages`, person, { id: randomUUID(), body }), 201),
  task: async (title: string, extra: Record<string, unknown> = {}) => (await json<{ id: string; revision: number }>(request('POST', `${base}/tasks`, owner, { title, ...extra }), 201)),
  tag: (name: string, extra: Record<string, unknown> = {}) => json<{ id: string; revision: number }>(request('POST', `${base}/tags`, owner, { name, ...extra }), 201),
  threadOf: async (column: 'task_id' | 'reservation_id' | 'stock_item_id', id: string) => (await db.owner.unsafe(`select id from threads where ${column} = $1`, [id]))[0]!.id as string,
  detail: (person: Person, id: string) => json<Detail>(request('GET', `${threads}/${id}`, person)),
  addTag: async (thread: string, tag: string) => {
   const revision = (await b.detail(owner, thread)).thread.revision;
   return json<Detail>(request('POST', `${threads}/${thread}/tags/${tag}`, owner, { expectedRevision: revision }));
  },
 };
 return b;
}
const ids = (result: { threads: { id: string }[] }) => result.threads.map(row => row.id);

before(async () => {
 if (!databaseUrl) return;
 db = await freshDatabase();
 let clock = Date.now();
 commitments = new CommitmentsService(db.app);
 app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
  organisations: new OrganisationService(db.app), commitments, rateLimiter: new RateLimiter(() => (clock += 61_000)) });
});
after(async () => { await db?.close(); });

test('search words become a prefix tsquery of letters and digits only', () => {
 assert.equal(searchTerms('Ferm tank'), 'ferm:* & tank:*');
 assert.equal(searchTerms("o'clock & | ! :* (x)"), 'o:* & clock:* & x:*', 'tsquery syntax never reaches the query');
 assert.equal(searchTerms('Brü 3'), 'brü:* & 3:*');
 assert.equal(searchTerms('!! ??'), null);
 assert.equal(searchTerms('a b c d e f g h i j')!.split(' & ').length, 8);
});

it('search matches titles and live message text, in the list’s row shape with the match, and nothing else', async () => {
 const b = await business('Search basics');
 const kettle = await b.task('Descale the kettle', { ownerId: b.member.user.id });
 const kettleThread = await b.threadOf('task_id', kettle.id);
 const topic = await b.topic(b.member, 'Hop delivery Thursday');
 await b.send(b.owner, topic, 'The fermenter needs cleaning before the delivery.');
 const quiet = await b.topic(b.member, 'Unrelated chat');
 const said = await b.send(b.owner, quiet, 'Fermentation is slow this week');
 // A deleted message no longer matches; change lines (the task's creation) never do.
 const gone = await b.topic(b.member, 'Pricing');
 const deleted = await b.send(b.owner, gone, 'Fermenter quote from the supplier');
 await json(request('DELETE', `${b.threads}/${gone}/messages/${deleted.id}?expectedRevision=${deleted.revision}`, b.owner));

 const title = await b.search(b.member, 'kettle');
 assert.deepEqual(Object.keys(title).sort(), ['available', 'filter', 'q', 'threads'], 'no groups and no cursor');
 assert.deepEqual([title.filter, title.q, title.available], ['all', 'kettle', true]);
 assert.deepEqual(ids(title), [kettleThread]);
 const row = title.threads[0]!;
 assert.deepEqual(row.match, { kind: 'title', excerpt: 'Descale the «kettle»', authorName: null });
 const listed = (await b.list(b.member)).threads.find(t => t.id === kettleThread)!;
 const { match: _, ...shape } = row;
 assert.deepEqual(shape, listed, 'a result is the list’s row, plus its match');

 // Prefix and stemming: "ferm" finds fermenter and fermentation; the deleted quote does not count.
 const ferm = await b.search(b.member, 'ferm');
 assert.deepEqual(new Set(ids(ferm)), new Set([topic, quiet]));
 const fromQuiet = ferm.threads.find(t => t.id === quiet)!;
 assert.equal(fromQuiet.match.kind, 'message');
 assert.equal(fromQuiet.match.authorName, `Olive ${people}`);
 assert.equal(fromQuiet.match.excerpt, '«Fermentation» is slow this week');
 assert.ok(said.id);
 assert.deepEqual(ids(await b.search(b.member, 'supplier quote')), [], 'a deleted message is not searched');
 assert.deepEqual(ids(await b.search(b.member, 'descale created')), [], 'all the words must match');
 assert.deepEqual(ids(await b.search(b.member, 'zebra')), []);
 assert.deepEqual(ids(await b.search(b.member, 'the and of')), [], 'only stop words: nothing, not everything');
 assert.deepEqual((await b.search(b.member, '!!')).threads, [], 'no words at all');
});

it('a private thread matches only for its participants, and a non-participant’s answer gives no hint it exists', async () => {
 const b = await business('Search privacy');
 const secret = await b.private(b.owner, 'Margin review', [b.member.user.id], 'Our wholesale margin is thin');
 await b.topic(b.other, 'Open thread about lunch');
 for (const person of [b.owner, b.member]) {
  const result = await b.search(person, 'margin');
  assert.deepEqual(ids(result), [secret], 'a participant matches the title');
  assert.equal(result.threads[0]!.match.kind, 'title');
  const byMessage = await b.search(person, 'wholesale thin');
  assert.deepEqual(ids(byMessage), [secret], 'and the message text');
  assert.equal(byMessage.threads[0]!.match.excerpt, 'Our «wholesale» margin is «thin»');
 }
 // The outsider: the same answer as for words nobody wrote, byte for byte (only `q` differs, and it is theirs).
 for (const q of ['margin', 'wholesale thin', 'Margin review']) {
  const outsider = await b.searchRaw(b.other, q);
  const nothing = await b.searchRaw(b.other, 'qqqqzzzz');
  assert.equal(outsider.status, 200); assert.equal(nothing.status, 200);
  const [seen, none] = [await outsider.json() as Search, await nothing.json() as Search];
  assert.deepEqual({ ...seen, q: '' }, { ...none, q: '' }, q);
  assert.ok(!JSON.stringify(seen).includes(secret));
 }
 // With a filter too, and a removed participant loses the match with the thread.
 assert.deepEqual(ids(await b.search(b.other, 'margin', '&filter=needs_you')), []);
 const revision = (await db.owner<{ revision: number }[]>`select revision from threads where id = ${secret}`)[0]!.revision;
 await json(request('DELETE', `${b.threads}/${secret}/participants/${b.member.user.id}?expectedRevision=${revision}`, b.owner));
 assert.deepEqual(ids(await b.search(b.member, 'wholesale')), []);
 assert.deepEqual(ids(await b.search(b.owner, 'wholesale')), [secret]);
 // Another tenant's member, or a stranger, gets the same 404 as for the list.
 assert.equal((await b.searchRaw((await business('Elsewhere')).owner, 'margin')).status, 404);
});

it('results rank title matches first, then by how well the messages match, then by activity; limit is at most 50', async () => {
 const b = await business('Search ranking');
 const inMessage = await b.topic(b.member, 'Brewing schedule');
 await b.send(b.owner, inMessage, 'Book the canning line for the IPA');
 const often = await b.topic(b.member, 'Packaging notes');
 await b.send(b.owner, often, 'Canning first, then canning again, canning all day');
 const titled = await b.task('Canning line service');
 const titledThread = await b.threadOf('task_id', titled.id);
 const result = await b.search(b.member, 'canning');
 assert.deepEqual(ids(result), [titledThread, often, inMessage], 'title, then the stronger message match, then the weaker');
 // Equal rank: newest activity first.
 const older = await b.topic(b.member, 'Kegging plan A');
 const newer = await b.topic(b.member, 'Kegging plan B');
 assert.deepEqual(ids(await b.search(b.member, 'kegging')), [newer, older]);
 await b.send(b.owner, older, 'Bumped');
 assert.deepEqual(ids(await b.search(b.member, 'kegging')), [older, newer]);
 assert.deepEqual(ids(await b.search(b.member, 'canning', '&limit=2')), [titledThread, often]);
 assert.equal((await json<Failure>(b.searchRaw(b.member, 'canning', '&limit=51'), 400)).code, 'invalid_request');
});

it('the excerpt marks every matching term with « and »; a text’s own marks become plain quotes', async () => {
 const b = await business('Search excerpts');
 const topic = await b.topic(b.member, 'Label printing');
 await b.send(b.owner, topic, 'The printer said «yeast» twice: first the yeast labels, then more about printers and yeast strains for the autumn range, and the long list goes on and on past the excerpt');
 const result = (await b.search(b.member, 'yeast')).threads[0]!;
 assert.equal(result.match.kind, 'message');
 const marks = result.match.excerpt.match(/«[^«»]+»/g) ?? [];
 assert.ok(marks.length >= 2 && marks.every(m => m.toLowerCase() === '«yeast»'), result.match.excerpt);
 assert.ok(result.match.excerpt.includes('"«yeast»"'), 'the body’s own guillemets are quotes now');
 assert.equal((result.match.excerpt.match(/«/g) ?? []).length, (result.match.excerpt.match(/»/g) ?? []).length);
 assert.ok(result.match.excerpt.split(/\s+/).length <= 20, 'one short fragment');
 const prefix = (await b.search(b.member, 'print lab')).threads[0]!;
 assert.equal(prefix.match.excerpt, '«Label» «printing»', 'a title is shown whole, prefixes marked');
});

it('q needs 2 characters after trimming, at most 200, no cursor, and combines with every filter', async () => {
 const b = await business('Search filters');
 for (const q of ['', 'a', ' a ', '🍺']) assert.equal((await json<Failure>(b.searchRaw(b.member, q), 400)).code, q === '' || [...q.trim()].length < 2 ? 'query_too_short' : 'invalid_request', JSON.stringify(q));
 assert.equal((await json<Failure>(b.searchRaw(b.member, 'x'.repeat(201)), 400)).code, 'invalid_request');
 assert.equal((await json<Failure>(b.searchRaw(b.member, 'ok', '&after=abc'), 400)).code, 'invalid_request', 'no further pages');
 assert.equal((await b.search(b.member, 'ab')).available, true, 'two characters search');
 // One of each kind, all called "Tank …", one owned by the member (so it needs them) and one stock item archived.
 const task = await b.task('Tank 1 clean', { ownerId: b.member.user.id });
 const done = await b.task('Tank 2 inspect');
 const equipment = (await json<{ id: string }>(request('POST', `${b.base}/equipment`, b.owner, { name: 'Fermenter' }), 201)).id;
 const booking = (await json<{ id: string }>(request('POST', `${b.base}/equipment/${equipment}/reservations`, b.owner,
  { id: randomUUID(), title: 'Tank 3 brew', startsAt: '2031-05-01T08:00:00Z', endsAt: '2031-05-01T12:00:00Z' }), 201)).id;
 const stock = (await json<{ id: string }>(request('POST', `${b.base}/stock`, b.owner, { name: 'Tank 4 sanitiser', location: 'Store', unitLabel: 'l' }), 201)).id;
 const archived = (await json<{ id: string; revision: number }>(request('POST', `${b.base}/stock`, b.owner, { name: 'Tank 5 old', location: 'Store', unitLabel: 'l' }), 201));
 await json(request('PATCH', `${b.base}/stock/${archived.id}`, b.owner, { expectedRevision: archived.revision, archived: true }));
 const topic = await b.topic(b.owner, 'Tank 6 question');
 const [t, d, r, s, a] = [await b.threadOf('task_id', task.id), await b.threadOf('task_id', done.id), await b.threadOf('reservation_id', booking),
  await b.threadOf('stock_item_id', stock), await b.threadOf('stock_item_id', archived.id)];
 // Mark everything read for the member, so only the owned open task needs them.
 for (const id of [t, d, r, s, a, topic]) {
  const seq = (await db.owner<{ lastSeq: number }[]>`select last_seq from threads where id = ${id}`)[0]!.lastSeq;
  await json(request('POST', `${b.threads}/${id}/read`, b.member, { seq }));
 }
 const set = async (filter: string) => new Set(ids(await b.search(b.member, 'tank', `&filter=${filter}`)));
 assert.deepEqual(await set('all'), new Set([t, d, r, s, a, topic]));
 assert.deepEqual(await set('tasks'), new Set([t, d]));
 assert.deepEqual(await set('bookings'), new Set([r]));
 assert.deepEqual(await set('stock'), new Set([s]), 'archived items leave Stock');
 assert.deepEqual(await set('records'), new Set([t, d, r, s, a]));
 assert.deepEqual(await set('needs_you'), new Set([t]));
 for (const filter of ['files', 'people']) assert.deepEqual(await b.search(b.member, 'tank', `&filter=${filter}`), { filter, q: 'tank', available: false, threads: [] });
 assert.equal((await b.searchRaw(b.member, 'tank', '&filter=everything')).status, 400);
});

it('an archived tag has no heading: its threads fall under their other tags or Other, and keep the tag on their detail', async () => {
 const b = await business('Archived headings');
 const old = await b.tag('Spring release'), kept = await b.tag('Production');
 const only = await b.topic(b.member, 'Only the old tag'), both = await b.topic(b.member, 'Both tags');
 await b.addTag(only, old.id); await b.addTag(both, old.id); await b.addTag(both, kept.id);
 const before = await b.list(b.member);
 assert.deepEqual(before.groups.map(g => [g.label, g.threads]), [['Spring release', 2], ['Production', 1]]);
 await json(request('PATCH', `${b.base}/tags/${old.id}`, b.owner, { expectedRevision: old.revision, archived: true }));
 const list = await b.list(b.member);
 assert.deepEqual(list.groups.map(g => [g.key, g.threads]), [['none', 1], [kept.id, 1]], 'by count, then name: Other before Production');
 assert.deepEqual(list.threads.find(t => t.id === only)!.tags, [], 'a row carries the live tags it is grouped by');
 assert.deepEqual(list.threads.find(t => t.id === both)!.tags.map(t => t.id), [kept.id]);
 assert.deepEqual((await b.detail(b.member, only)).tags.map(t => t.id), [old.id], 'the attachment is kept');
 await json(request('PATCH', `${b.base}/tags/${old.id}`, b.owner, { expectedRevision: old.revision + 1, archived: false }));
 assert.deepEqual((await b.list(b.member)).groups.map(g => [g.label, g.threads]), [['Spring release', 2], ['Production', 1]], 'restoring brings the heading back');
});

it('tags list their visible thread counts on request, and one tag reads by id; private threads count only for participants', async () => {
 const b = await business('Tag counts');
 const tag = await b.tag('Wholesale', { ownerId: b.member.user.id, startsOn: '2031-01-01' }), empty = await b.tag('Empty');
 await b.addTag(await b.topic(b.member, 'Price list'), tag.id);
 await b.addTag(await b.private(b.owner, 'Margins', [], 'Only me'), tag.id);
 const plain = await json<{ tags: Record<string, unknown>[] }>(request('GET', `${b.base}/tags`, b.member));
 assert.ok(plain.tags.every(t => !('threads' in t)), 'without counts the page is as before');
 const counted = async (person: Person) => Object.fromEntries((await json<{ tags: { id: string; threads: number }[] }>(request('GET', `${b.base}/tags?counts=true`, person))).tags.map(t => [t.id, t.threads]));
 assert.deepEqual(await counted(b.member), { [tag.id]: 1, [empty.id]: 0 });
 assert.deepEqual(await counted(b.owner), { [tag.id]: 2, [empty.id]: 0 });
 const one = await json<{ id: string; name: string; ownerId: string; startsOn: string; endsOn: null; threads: number; revision: number }>(request('GET', `${b.base}/tags/${tag.id}`, b.member));
 assert.deepEqual([one.id, one.name, one.ownerId, one.startsOn, one.endsOn, one.threads], [tag.id, 'Wholesale', b.member.user.id, '2031-01-01', null, 1]);
 assert.equal((await request('GET', `${b.base}/tags/${randomUUID()}`, b.member)).status, 404);
 assert.equal((await request('GET', `${b.base}/tags?counts=yes`, b.member)).status, 400);
 const elsewhere = await business('Other tenant');
 assert.equal((await request('GET', `${elsewhere.base}/tags/${tag.id}`, elsewhere.owner)).status, 404, 'another tenant’s tag is not found');
});

it('repeat this task: the series carries its title, body, tags and owner, the task becomes its occurrence, and later ones link back', async () => {
 const b = await business('Repeat a task');
 const tag = await b.tag('Compliance');
 const task = await b.task('Excise return', { body: 'File by the 21st', ownerId: b.member.user.id, due: '2026-10-21' });
 const thread = await b.threadOf('task_id', task.id);
 await b.addTag(thread, tag.id);
 const revision = async () => (await db.owner<{ revision: number }[]>`select revision from tasks where id = ${task.id}`)[0]!.revision;
 const today = (await db.owner<{ today: string }[]>`select (now() at time zone timezone)::date::text as today from organisations where id = ${b.org}`)[0]!.today;
 const anchor = `${today.slice(0, 7)}-01`;
 const body = (extra: Record<string, unknown> = {}) => ({ title: 'Excise return', body: 'File by the 21st', ownerId: b.member.user.id, tagIds: [tag.id], evidenceRequired: true,
  recurrence: 'monthly', anchor, dueOffsetDays: 21, ...extra });
 assert.equal((await json<Failure>(request('POST', `${b.base}/series`, b.member, body({ fromTask: { id: task.id, expectedRevision: (await revision()) + 1 } })), 409)).code, 'stale_revision');
 const changeSetId = randomUUID();
 const series = await json<Series>(request('POST', `${b.base}/series`, b.member, body({ changeSetId, fromTask: { id: task.id, expectedRevision: await revision() } })), 201);
 assert.deepEqual([series.title, series.body, series.ownerId, series.tagIds, series.recurrence], ['Excise return', 'File by the 21st', b.member.user.id, [tag.id], 'monthly']);
 // The task is this month's occurrence: no second copy, its own title and due date kept, its card names the series.
 const occurrences = [...await db.owner<{ id: string; periodStart: string; due: string }[]>`select id, period_start::text, due::text from tasks where series_id = ${series.id}`];
 assert.deepEqual(occurrences, [{ id: task.id, periodStart: anchor, due: '2026-10-21' }]);
 assert.equal((await b.detail(b.member, thread)).card.fold.seriesId, series.id);
 const detail = await json<{ task: { seriesId: string }; series: { id: string; title: string } }>(request('GET', `${b.base}/tasks/${task.id}`, b.member));
 assert.deepEqual(detail.series, { id: series.id, title: 'Excise return' });
 // One change set: the series and the task's link, journalled together, and the retry answers the same series.
 const changed = await db.owner<{ recordKind: string; field: string | null }[]>`select record_kind, field from record_changes where change_set_id = ${changeSetId} order by record_kind, field nulls first`;
 assert.ok(changed.some(c => c.recordKind === 'task' && c.field === 'series_id'), JSON.stringify(changed));
 assert.ok(changed.some(c => c.recordKind === 'series'));
 const retried = await json<Series>(request('POST', `${b.base}/series`, b.member, body({ changeSetId, fromTask: { id: task.id, expectedRevision: (await revision()) - 1 } })), 201);
 assert.equal(retried.id, series.id);
 // Refusals: a task already in a series, a step, a cancelled task.
 assert.equal((await json<Failure>(request('POST', `${b.base}/series`, b.member, body({ fromTask: { id: task.id, expectedRevision: await revision() } })), 409)).code, 'task_in_series');
 const step = await json<{ id: string; revision: number }>(request('POST', `${b.base}/tasks`, b.owner, { title: 'Gather receipts', parentId: task.id, expectedParentRevision: await revision() }), 201);
 assert.equal((await json<Failure>(request('POST', `${b.base}/series`, b.member, body({ fromTask: { id: step.id, expectedRevision: step.revision } })), 400)).code, 'task_is_step');
 const cancelled = await b.task('Old return', { status: 'cancelled' });
 assert.equal((await json<Failure>(request('POST', `${b.base}/series`, b.member, body({ fromTask: { id: cancelled.id, expectedRevision: cancelled.revision } })), 409)).code, 'task_cancelled');
 // The routine finds this month done; next month's occurrence is new, with the series' owner and tags, and links back.
 assert.equal(await commitments.materialise(b.org, today), 0);
 const next = new Date(`${anchor}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1);
 const nextMonth = next.toISOString().slice(0, 10);
 assert.equal(await commitments.materialise(b.org, nextMonth), 1);
 const [later] = await db.owner<{ id: string; ownerId: string; evidenceRequired: boolean }[]>`select id, owner_id, evidence_required from tasks where series_id = ${series.id} and period_start = ${nextMonth}::date`;
 assert.deepEqual([later!.ownerId, later!.evidenceRequired], [b.member.user.id, true]);
 const laterThread = await b.threadOf('task_id', later!.id);
 const laterDetail = await b.detail(b.member, laterThread);
 assert.deepEqual([laterDetail.card.fold.seriesId, laterDetail.tags.map(t => t.id)], [series.id, [tag.id]]);
});

it('repeat this task when the series starts later: the task is its first period, and the routine makes no copy of it', async () => {
 const b = await business('Repeat later');
 const task = await b.task('Quarterly safety walk');
 const series = await json<Series>(request('POST', `${b.base}/series`, b.owner, { title: 'Quarterly safety walk', recurrence: 'quarterly', anchor: '2031-01-01', dueOffsetDays: -7,
  fromTask: { id: task.id, expectedRevision: task.revision } }), 201);
 assert.deepEqual([...await db.owner`select period_start::text, period_end::text from tasks where series_id = ${series.id}`], [{ periodStart: '2031-01-01', periodEnd: '2031-03-31' }]);
 assert.equal(await commitments.materialise(b.org, '2031-02-01'), 0);
 assert.equal(await commitments.materialise(b.org, '2031-04-02'), 1);
});
