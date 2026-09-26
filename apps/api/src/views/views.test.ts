import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import type { WorkTask } from '../tags/service.ts';

// D26 / #141: private saved Work views against a real Postgres, through the real app and the non-bypassing `app` role.
const it = databaseUrl ? test : test.skip;
let db: Harness, app: ReturnType<typeof createApp>;
type Person = { token: string; user: { id: string } };
type Filter = { owner: 'me' | 'all'; status: string; tagIds: string[]; projectId: string | null };
type View = { id: string; name: string; filterVersion: number; filter: Filter; applicable: boolean; reason: string | null; revision: number; createdAt: string; updatedAt: string };
type Ref = { id: string; state: 'available' | 'missing' | 'unavailable'; name?: string; projectState?: string };
type Detail = View & { references: { tags: Ref[]; project: Ref | null } | null };
type Failure = { ok: false; code: string; error: string; field?: string };
let owner: Person, member: Person, admin: Person, outsider: Person, org: string, otherOrg: string, project: string;
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
async function signIn(subject: string): Promise<Person> {
 google.next = { subject, email: `${subject}@example.test`, name: subject };
 const start = await app.request('/auth/google/start');
 const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
 const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
 const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
 return json(request('POST', '/auth/session/exchange', undefined, { code }));
}
const join = async (person: Person, role: 'member' | 'admin' = 'member', organisationId = org) =>
 db.owner`insert into memberships (organisation_id, user_id, role) values (${organisationId}, ${person.user.id}, ${role})`;
const base = (organisationId = org) => `/v1/organisations/${organisationId}`;
const views = (organisationId = org) => `${base(organisationId)}/views`;
const filter = (over: Partial<Filter> = {}): Filter => ({ owner: 'me', status: 'open', tagIds: [], projectId: null, ...over });
const create = (person: Person, body: unknown, organisationId = org) => request('POST', views(organisationId), person, body);
const newView = (person: Person, name: string, f: Filter = filter(), organisationId = org) =>
 json<View>(create(person, { id: randomUUID(), name, filter: f }, organisationId), 201);
const patch = (person: Person, id: string, body: unknown) => request('PATCH', `${views()}/${id}`, person, body);
const remove = (person: Person, id: string, revision: number | string) => request('DELETE', `${views()}/${id}?expectedRevision=${revision}`, person);
const makeTag = async (name: string, person = owner, organisationId = org) => (await json<{ id: string }>(request('POST', `${base(organisationId)}/tags`, person, { name }), 201)).id;
const makeProject = async (name: string, person = owner, organisationId = org) => (await json<{ id: string }>(request('POST', `${base(organisationId)}/projects`, person, { name }), 201)).id;
const liveCount = async (person: Person) => (await db.owner<{ n: number }[]>`select count(*)::int as n from saved_views
 where organisation_id = ${org} and owner_id = ${person.user.id} and deleted_at is null`)[0]!.n;
const row = async (id: string) => (await db.owner`select * from saved_views where id = ${id}`)[0];
const asApp = <T>(person: Person, work: (tx: TransactionSql) => Promise<T>, organisationId = org) => withTenant(db.app, { organisationId, userId: person.user.id }, work);

before(async () => {
 if (!databaseUrl) return;
 db = await freshDatabase();
 // Every request lands in a fresh window: these tests exercise views, not the rate limiter.
 let clock = Date.now();
 app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }),
  organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), rateLimiter: new RateLimiter(() => (clock += 61_000)) });
 owner = await signIn('views-owner'); member = await signIn('views-member'); admin = await signIn('views-admin'); outsider = await signIn('views-outsider');
 org = (await json<{ id: string }>(request('POST', '/v1/organisations', owner, { name: 'Harbour Brewing' }), 201)).id;
 otherOrg = (await json<{ id: string }>(request('POST', '/v1/organisations', outsider, { name: 'Other business' }), 201)).id;
 await join(member); await join(admin, 'admin');
 project = await makeProject('Autumn launch');
});
after(async () => { await db?.close(); });

it('creates, reads, renames, refilters and tombstones a view, normalising the filter and auditing identity only', async () => {
 const production = await makeTag('Production'), sales = await makeTag('Sales');
 const id = randomUUID().toUpperCase();
 const created = await json<View>(create(member, { id, name: '  Brew days  ', filter: { owner: 'all', status: 'in_progress',
  tagIds: [sales.toUpperCase(), production, sales], projectId: project.toUpperCase() } }), 201);
 const viewId = id.toLowerCase();
 assert.deepEqual(Object.keys(created), ['id', 'name', 'filterVersion', 'filter', 'applicable', 'reason', 'revision', 'createdAt', 'updatedAt']);
 assert.equal(created.id, viewId); assert.equal(created.name, 'Brew days'); assert.equal(created.filterVersion, 1);
 assert.equal(created.applicable, true); assert.equal(created.reason, null); assert.equal(created.revision, 1);
 const normalised = { owner: 'all', status: 'in_progress', tagIds: [production, sales].sort(), projectId: project };
 assert.deepEqual(created.filter, normalised);
 const stored = await row(viewId);
 assert.deepEqual(stored!.filter, normalised, 'the database holds the normalised filter');
 assert.equal(stored!.filterVersion, 1); assert.equal(stored!.ownerId, member.user.id); assert.equal(stored!.section, 'work');

 const detail = await json<Detail>(request('GET', `${views()}/${viewId}`, member));
 assert.deepEqual(detail.filter, normalised);
 assert.deepEqual(detail.references, {
  tags: normalised.tagIds.map(tagId => ({ id: tagId, state: 'available', name: tagId === production ? 'Production' : 'Sales' })),
  project: { id: project, state: 'available', name: 'Autumn launch', projectState: 'active' },
 });
 const listed = await json<{ views: View[]; nextOffset: number | null }>(request('GET', views(), member));
 assert.deepEqual(listed.views.map(v => v.id), [viewId]); assert.equal(listed.nextOffset, null);
 assert.ok(!('references' in listed.views[0]!), 'list rows omit references');

 const renamed = await json<View>(patch(member, viewId, { expectedRevision: 1, name: 'Brewing' }));
 assert.equal(renamed.revision, 2); assert.equal(renamed.name, 'Brewing'); assert.deepEqual(renamed.filter, normalised);
 const refiltered = await json<View>(patch(member, viewId, { expectedRevision: 2, filter: filter({ tagIds: [production] }) }));
 assert.equal(refiltered.revision, 3); assert.equal(refiltered.name, 'Brewing');
 assert.deepEqual(refiltered.filter, { owner: 'me', status: 'open', tagIds: [production], projectId: null }, 'a supplied filter replaces the whole filter');
 assert.deepEqual(await json(remove(member, viewId, 3)), { ok: true });
 assert.equal((await request('GET', `${views()}/${viewId}`, member)).status, 404);
 assert.deepEqual((await json<{ views: View[] }>(request('GET', views(), member))).views, []);
 const tombstone = await row(viewId);
 assert.ok(tombstone!.deletedAt); assert.equal(tombstone!.name, null); assert.equal(tombstone!.filter, null); assert.equal(tombstone!.filterVersion, null);
 assert.equal(tombstone!.revision, 4); assert.equal(tombstone!.ownerId, member.user.id);

 const audit = await db.owner<{ action: string; actorId: string; subjectType: string; subjectId: string; detail: Record<string, unknown> }[]>`
  select action, actor_id, subject_type, subject_id, detail from audit_events where subject_id = ${viewId} order by created_at, id`;
 assert.deepEqual(audit.map(a => a.action), ['saved_view.created', 'saved_view.updated', 'saved_view.updated', 'saved_view.deleted']);
 assert.ok(audit.every(a => a.actorId === member.user.id && a.subjectType === 'saved_view'));
 assert.deepEqual(audit.map(a => a.detail), [1, 2, 3, 4].map(revision => ({ viewId, filterVersion: 1, revision })));
 const text = JSON.stringify(audit);
 for (const secret of ['Brew days', 'Brewing', production, sales, project]) assert.ok(!text.includes(secret), `audit must not carry ${secret}`);
});

it('refuses malformed filters and bodies with the contract codes and writes nothing', async () => {
 const tag = await makeTag('Validation');
 const before = await liveCount(member);
 const invalid: unknown[] = [
  { owner: 'me', status: 'open', tagIds: [] }, { owner: 'me', status: 'open', projectId: null }, { status: 'open', tagIds: [], projectId: null },
  { owner: 'me', tagIds: [], projectId: null }, { ...filter(), due: 'this-week' }, { ...filter(), owner: 'someone' }, { ...filter(), owner: 'ME' },
  { ...filter(), status: 'any' }, { ...filter(), tagIds: Array.from({ length: 21 }, () => randomUUID()) }, { ...filter(), tagIds: ['not-a-uuid'] },
  { ...filter(), tagIds: Array(101).fill(tag) }, { ...filter(), tagIds: tag }, { ...filter(), projectId: 'x' }, { ...filter(), projectId: undefined }, [], 'owner=me', null, 1,
 ];
 for (const candidate of invalid) {
  const failure = await json<Failure>(create(member, { id: randomUUID(), name: 'Bad filter', filter: candidate }), 400);
  assert.equal(failure.code, 'invalid_filter', JSON.stringify(candidate));
 }
 for (const body of [{ name: 'No id', filter: filter() }, { id: 'nope', name: 'Bad id', filter: filter() }, { id: randomUUID(), name: '', filter: filter() },
  { id: randomUUID(), name: '    ', filter: filter() }, { id: randomUUID(), name: 'x'.repeat(61), filter: filter() }, { id: randomUUID(), filter: filter() },
  { id: randomUUID(), name: 'Extra', filter: filter(), shared: true }, { id: randomUUID(), name: 'Version', filter: filter(), filterVersion: 1 }]) {
  assert.equal((await create(member, body)).status, 400, JSON.stringify(body));
 }
 const malformed = await app.request(views(), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${member.token}` }, body: '{bad' });
 assert.equal((await json<Failure>(malformed, 400)).code, 'invalid_request');
 assert.equal(await liveCount(member), before, 'no refused request wrote a row');

 const dupes = await newView(member, 'Duplicates', filter({ tagIds: [tag.toUpperCase(), ...Array<string>(25).fill(tag)] }));
 assert.deepEqual(dupes.filter.tagIds, [tag]);
 const sixty = await newView(member, 'y'.repeat(60)); assert.equal(sixty.name.length, 60);
 for (const body of [{ expectedRevision: 1 }, { expectedRevision: 0, name: 'Zero' }, { expectedRevision: 1, name: 'Ok', owner: member.user.id },
  { expectedRevision: '1', name: 'String' }, { name: 'No revision' }]) {
  assert.equal((await patch(member, dupes.id, body)).status, 400, JSON.stringify(body));
 }
 assert.equal((await json<Failure>(patch(member, dupes.id, { expectedRevision: 1, filter: { ...filter(), extra: true } }), 400)).code, 'invalid_filter');
 assert.equal((await json<Failure>(patch(member, dupes.id, { expectedRevision: 1, filter: null }), 400)).code, 'invalid_filter');
 for (const query of ['', '?expectedRevision=', '?expectedRevision=abc', '?expectedRevision=0', '?expectedRevision=1&hard=true', '?expectedRevision=1&expectedRevision=2'])
  assert.equal((await request('DELETE', `${views()}/${dupes.id}${query}`, member)).status, 400, query);
 assert.equal((await row(dupes.id))!.revision, 1, 'refused edits leave the view untouched');
 assert.equal((await row(dupes.id))!.deletedAt, null, 'ambiguous delete preconditions never delete');
 assert.equal((await request('GET', `${views()}/not-a-uuid`, member)).status, 400);
});

it('validates referenced tags and projects in the tenant at save time, including archived projects', async () => {
 const local = await makeTag('Local tag');
 const foreignTag = await makeTag('Foreign tag', outsider, otherOrg);
 const foreignProject = await makeProject('Foreign project', outsider, otherOrg);
 const cases: [Partial<Filter>, 'tagIds' | 'projectId'][] = [
  [{ tagIds: [local, randomUUID()] }, 'tagIds'], [{ tagIds: [foreignTag] }, 'tagIds'],
  [{ projectId: randomUUID() }, 'projectId'], [{ projectId: foreignProject }, 'projectId'],
 ];
 for (const [over, field] of cases) {
  const failure = await json<Failure>(create(member, { id: randomUUID(), name: 'Refused reference', filter: filter(over) }), 400);
  assert.equal(failure.code, 'filter_reference_unavailable'); assert.equal(failure.field, field);
  assert.ok(!failure.error.includes('Foreign'), 'the refusal names the field, not another tenant’s record');
 }
 const archived = await makeProject('Archived work');
 const revision = Number((await db.owner`select revision from projects where id = ${archived}`)[0]!.revision);
 await json(request('PATCH', `${base()}/projects/${archived}`, owner, { expectedRevision: revision, archived: true }));
 const kept = await newView(member, 'Archived project', filter({ projectId: archived, status: 'all' }));
 assert.equal(kept.filter.projectId, archived);
 assert.equal((await json<Detail>(request('GET', `${views()}/${kept.id}`, member))).references!.project!.projectState, 'archived');

 const view = await newView(member, 'Refilter refused', filter({ tagIds: [local] }));
 const refused = await json<Failure>(patch(member, view.id, { expectedRevision: 1, filter: filter({ tagIds: [foreignTag] }) }), 400);
 assert.equal(refused.code, 'filter_reference_unavailable'); assert.equal(refused.field, 'tagIds');
 assert.deepEqual((await row(view.id))!.filter, filter({ tagIds: [local] }));

 // References are only checked when a filter is supplied: a name-only change keeps a view whose project has since gone.
 const temporary = await makeProject('Short-lived');
 const orphan = await newView(member, 'Orphan', filter({ projectId: temporary }));
 await db.owner`delete from projects where id = ${temporary}`;
 const renamed = await json<View>(patch(member, orphan.id, { expectedRevision: 1, name: 'Orphan renamed' }));
 assert.equal(renamed.filter.projectId, temporary);
 assert.equal((await json<Failure>(patch(member, orphan.id, { expectedRevision: 2, filter: filter({ projectId: temporary }) }), 400)).field, 'projectId');
});

it('same-id create retries return the stored view once and never resurrect or reveal another row', async () => {
 const id = randomUUID(); const body = { id, name: 'Retry me', filter: filter({ status: 'all' }) };
 const first = await json<View>(create(member, body), 201);
 const again = await json<View>(create(member, { ...body, id: id.toUpperCase(), name: ' Retry me ' }), 200);
 assert.deepEqual(again, first, 'an identical retry, after normalisation, returns the stored view');
 assert.equal((await db.owner`select * from saved_views where id = ${id}`).length, 1);
 assert.equal((await db.owner`select * from audit_events where subject_id = ${id}`).length, 1, 'a retry writes no audit');

 assert.equal((await json<Failure>(create(member, { ...body, filter: filter({ status: 'open' }) }), 409)).code, 'view_id_unavailable');
 assert.equal((await json<Failure>(create(member, { ...body, name: 'Retry you' }), 409)).code, 'view_id_unavailable');
 assert.equal((await json<Failure>(create(member, { ...body, name: 'retry me' }), 409)).code, 'view_id_unavailable', 'names match exactly for a retry');
 await json(patch(member, id, { expectedRevision: 1, name: 'Renamed since' }));
 assert.equal((await json<Failure>(create(member, body), 409)).code, 'view_id_unavailable', 'a retry after a rename conflicts');
 await json(remove(member, id, 2));
 const afterDelete = await json<Failure>(create(member, { ...body, name: 'Renamed since' }), 409);
 assert.equal(afterDelete.code, 'view_id_unavailable');
 const tombstone = await row(id);
 assert.ok(tombstone!.deletedAt, 'the tombstone stays deleted'); assert.equal(tombstone!.name, null); assert.equal(tombstone!.revision, 3);
 assert.equal((await request('GET', `${views()}/${id}`, member)).status, 404);
 assert.equal((await remove(member, id, 3)).status, 404, 'a second delete is 404');

 // Another member's id and another tenant's id: the same generic 409 as this person's own tombstone, and no content.
 const secret = await newView(owner, 'Owner secret plans', filter({ owner: 'all' }));
 const foreign = await newView(outsider, 'Outsider secret plans', filter(), otherOrg);
 const hiddenMember = await json<Failure>(create(member, { id: secret.id, name: 'Anything', filter: filter() }), 409);
 const hiddenTenant = await json<Failure>(create(member, { id: foreign.id, name: 'Anything', filter: filter() }), 409);
 assert.deepEqual(hiddenMember, afterDelete); assert.deepEqual(hiddenTenant, afterDelete);
 assert.deepEqual(Object.keys(hiddenMember).sort(), ['code', 'error', 'ok']);
 for (const text of [JSON.stringify(hiddenMember), JSON.stringify(hiddenTenant)]) assert.ok(!/secret|Owner|Outsider/.test(text));
 const identicalToOwners = await create(member, { id: secret.id, name: 'Owner secret plans', filter: filter({ owner: 'all' }) });
 assert.equal(identicalToOwners.status, 409, 'even an identical body cannot claim another person’s id');
 assert.equal((await row(secret.id))!.ownerId, owner.user.id); assert.equal((await row(secret.id))!.revision, 1);
 assert.equal((await row(foreign.id))!.organisationId, otherOrg);
});

it('concurrent identical creates make one row; concurrent edits from one revision let exactly one win', async () => {
 const id = randomUUID(); const body = { id, name: 'Racing create', filter: filter() };
 const statuses = (await Promise.all([create(member, body), create(member, body)])).map(r => r.status).sort();
 assert.deepEqual(statuses, [200, 201]);
 assert.equal((await db.owner`select * from saved_views where id = ${id}`).length, 1);
 assert.equal((await db.owner`select * from audit_events where subject_id = ${id} and action = 'saved_view.created'`).length, 1);

 const edits = await Promise.all([patch(member, id, { expectedRevision: 1, name: 'Tab A' }), patch(member, id, { expectedRevision: 1, filter: filter({ status: 'done' }) })]);
 assert.deepEqual(edits.map(r => r.status).sort(), [200, 409]);
 const loser = edits.find(r => r.status === 409)!;
 assert.equal(((await loser.json()) as Failure).code, 'stale_revision');
 const stored = (await row(id))!;
 assert.equal(stored.revision, 2);
 assert.ok(stored.name === 'Tab A' ? stored.filter.status === 'open' : stored.name === 'Racing create' && stored.filter.status === 'done', 'only the winner’s change is stored');
 assert.equal((await json<Failure>(remove(member, id, 1), 409)).code, 'stale_revision');
 assert.equal((await row(id))!.deletedAt, null);
 const racingDeletes = await Promise.all([remove(member, id, 2), remove(member, id, 2)]);
 assert.deepEqual(racingDeletes.map(r => r.status).sort(), [200, 404]);
 // Different memberships do not share a lock. Neither unique index may turn a hidden-id collision into a 500.
 for (let attempt = 0; attempt < 3; attempt++) {
  const collisionId = randomUUID();
  const collision = { id: collisionId, name: `Cross-owner collision ${attempt}`, filter: filter() };
  const results = await Promise.all([create(member, collision), create(owner, collision)]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const conflict = await results.find(result => result.status === 409)!.json() as Failure;
  assert.equal(conflict.code, 'view_id_unavailable');
  assert.equal((await db.owner`select id from saved_views where id = ${collisionId}`).length, 1);
 }
});

it('names are unique per person case-insensitively among live views, and a deleted name can be reused', async () => {
 const weekly = await newView(member, 'Weekly');
 assert.equal((await json<Failure>(create(member, { id: randomUUID(), name: 'WEEKLY', filter: filter() }), 409)).code, 'view_name_exists');
 const other = await newView(member, 'Monthly');
 assert.equal((await json<Failure>(patch(member, other.id, { expectedRevision: 1, name: ' weekly ' }), 409)).code, 'view_name_exists');
 assert.equal((await row(other.id))!.revision, 1);
 await newView(owner, 'Weekly'); // another person may use the same name
 const racing = await Promise.all([create(member, { id: randomUUID(), name: 'Daily', filter: filter() }), create(member, { id: randomUUID(), name: 'daily', filter: filter() })]);
 assert.deepEqual(racing.map(r => r.status).sort(), [201, 409]);
 await json(remove(member, weekly.id, 1));
 const reused = await newView(member, 'weekly');
 assert.notEqual(reused.id, weekly.id);
});

it('at most 50 live views per person, checked under the membership lock; tombstones do not count', async () => {
 const limited = await signIn('views-limit'); await join(limited);
 await db.owner`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
  select gen_random_uuid(), ${org}, ${limited.user.id}, 'Seeded ' || lpad(n::text, 2, '0'), 1, ${db.owner.json(filter() as never)}
  from generate_series(1, 49) n`;
 const racing = await Promise.all([create(limited, { id: randomUUID(), name: 'Fiftieth A', filter: filter() }), create(limited, { id: randomUUID(), name: 'Fiftieth B', filter: filter() })]);
 assert.deepEqual(racing.map(r => r.status).sort(), [201, 409]);
 assert.equal(((await racing.find(r => r.status === 409)!.json()) as Failure).code, 'view_limit');
 assert.equal(await liveCount(limited), 50);
 const winner = (await racing.find(r => r.status === 201)!.json()) as View;
 assert.equal((await create(limited, { id: winner.id, name: winner.name, filter: filter() })).status, 200, 'an identical retry at the limit still returns the stored view');
 assert.equal((await json<Failure>(create(limited, { id: randomUUID(), name: 'Fifty-first', filter: filter() }), 409)).code, 'view_limit');
 const [seeded] = await db.owner<{ id: string }[]>`select id from saved_views where owner_id = ${limited.user.id} and name = 'Seeded 01'`;
 await json(remove(limited, seeded!.id, 1));
 await newView(limited, 'After a delete');
 assert.equal(await liveCount(limited), 50);
 await newView(member, 'Unaffected by another person’s limit');
});

it('only the owner, as an active member, can see or change a view — through the API and directly as app', async () => {
 const view = await newView(member, 'Member private', filter({ owner: 'all' }));
 for (const person of [owner, admin]) {
  assert.equal((await request('GET', `${views()}/${view.id}`, person)).status, 404);
  assert.equal((await patch(person, view.id, { expectedRevision: 1, name: 'Taken over' })).status, 404);
  assert.equal((await remove(person, view.id, 1)).status, 404);
  assert.ok(!(await json<{ views: View[] }>(request('GET', views(), person))).views.some(v => v.id === view.id));
 }
 assert.equal((await request('GET', `${views()}/${view.id}`, outsider)).status, 404);
 assert.equal((await request('GET', views(), outsider)).status, 404);
 assert.equal((await request('GET', `${views(otherOrg)}/${view.id}`, outsider)).status, 404);
 assert.equal((await request('GET', views())).status, 401);
 assert.equal((await row(view.id))!.revision, 1);

 for (const person of [owner, admin]) {
  assert.equal((await asApp(person, tx => tx`select * from saved_views where id = ${view.id}`)).length, 0);
  assert.equal((await asApp(person, tx => tx`update saved_views set name = 'Stolen' where id = ${view.id} returning id`)).length, 0);
 }
 assert.equal((await asApp(outsider, tx => tx`select * from saved_views`, otherOrg)).every(r => r.organisationId === otherOrg), true);
 for (const person of [member, owner]) await assert.rejects(asApp(person, tx => tx`delete from saved_views where id = ${view.id}`), /permission denied/);
 await assert.rejects(asApp(member, tx => tx`update saved_views set owner_id = ${owner.user.id} where id = ${view.id}`), /keeps its id|row-level security/);
 await assert.rejects(asApp(member, tx => tx`update saved_views set section = 'chat' where id = ${view.id}`), /keeps its id|check constraint/);
 await assert.rejects(asApp(member, tx => tx`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
  values (${randomUUID()}, ${org}, ${owner.user.id}, 'Planted', 1, ${tx.json(filter() as never)})`), /row-level security/);
 await assert.rejects(asApp(member, tx => tx`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
  values (${randomUUID()}, ${otherOrg}, ${member.user.id}, 'Elsewhere', 1, ${tx.json(filter() as never)})`), /row-level security/);
 assert.equal((await row(view.id))!.ownerId, member.user.id);

 // Removal hides the views at once; reactivation through a fresh invitation brings the same views back.
 await json(request('DELETE', `${base()}/members/${member.user.id}`, owner));
 assert.equal((await request('GET', views(), member)).status, 404);
 assert.equal((await request('GET', `${views()}/${view.id}`, member)).status, 404);
 assert.equal((await create(member, { id: randomUUID(), name: 'While removed', filter: filter() })).status, 404);
 assert.equal((await asApp(member, tx => tx`select * from saved_views`)).length, 0);
 assert.equal((await asApp(member, tx => tx`update saved_views set name = 'Removed edit' where id = ${view.id} returning id`)).length, 0);
 assert.equal((await row(view.id))!.name, 'Member private', 'a removed member’s views are kept');
 const invitation = await json<{ token: string }>(request('POST', `${base()}/invitations`, owner, { email: 'views-member@example.test', role: 'member' }), 201);
 await json(request('POST', '/v1/invitations/accept', member, { token: invitation.token }));
 const back = await json<Detail>(request('GET', `${views()}/${view.id}`, member));
 assert.equal(back.name, 'Member private'); assert.equal(back.revision, 1);
});

it('references resolve in bounded batches: available, missing and unavailable never change the stored filter', async () => {
 const person = await signIn('views-references'); await join(person);
 await db.owner`insert into tags (organisation_id, name) select ${org}, 'Bulk ' || lpad(n::text, 2, '0') from generate_series(1, 55) n`;
 const tail = await makeTag('zzz Tail tag'), gone = await makeTag('zzz Going'), kept = await makeTag('aaa Kept');
 const firstPage = await json<{ tags: { id: string }[]; nextOffset: number | null }>(request('GET', `${base()}/tags?limit=50`, person));
 assert.ok(firstPage.nextOffset !== null && !firstPage.tags.some(t => t.id === tail), 'the tail tag is on no first page');
 const leaving = await makeProject('Leaving project');
 const view = await newView(person, 'Resolved', filter({ owner: 'all', status: 'all', tagIds: [tail, gone, kept], projectId: leaving }));
 const sorted = [tail, gone, kept].sort();

 const available = await json<Detail>(request('GET', `${views()}/${view.id}`, person));
 assert.deepEqual(available.references!.tags.map(t => t.state), ['available', 'available', 'available']);
 assert.equal(available.references!.tags.find(t => t.id === tail)!.name, 'zzz Tail tag');
 assert.deepEqual(available.references!.tags.map(t => t.id), sorted);

 await db.owner`delete from tags where id = ${gone}`;
 await db.owner`delete from projects where id = ${leaving}`;
 const missing = await json<Detail>(request('GET', `${views()}/${view.id}`, person));
 assert.deepEqual(missing.references!.tags.find(t => t.id === gone), { id: gone, state: 'missing' });
 assert.equal(missing.references!.tags.find(t => t.id === kept)!.state, 'available');
 assert.deepEqual(missing.references!.project, { id: leaving, state: 'missing' });
 assert.deepEqual(missing.filter.tagIds, sorted, 'a missing reference stays in the filter');
 assert.equal(missing.filter.projectId, leaving);

 // Fault injection: the name reads fail, the record read does not.
 await db.owner`revoke select on tags from app`;
 try {
  const failed = await json<Detail>(request('GET', `${views()}/${view.id}`, person));
  assert.deepEqual(failed.references!.tags, sorted.map(id => ({ id, state: 'unavailable' })));
  assert.deepEqual(failed.references!.project, { id: leaving, state: 'missing' });
  assert.deepEqual(failed.filter, missing.filter); assert.equal(failed.revision, 1);
  assert.equal((await json<{ views: View[] }>(request('GET', views(), person))).views[0]!.id, view.id);
 } finally { await db.owner`grant select on tags to app`; }
 const project2 = await makeProject('Present project');
 const withProject = await newView(person, 'Project unavailable', filter({ projectId: project2, tagIds: [kept] }));
 await db.owner`revoke select on projects from app`;
 try {
  const failed = await json<Detail>(request('GET', `${views()}/${withProject.id}`, person));
  assert.deepEqual(failed.references!.project, { id: project2, state: 'unavailable' });
  assert.deepEqual(failed.references!.tags, [{ id: kept, state: 'available', name: 'aaa Kept' }]);
  assert.equal(failed.filter.projectId, project2);
 } finally { await db.owner`grant select on projects to app`; }

 // The Work list is queried with exactly the stored IDs: a missing tag narrows to nothing, it never widens to everything.
 const task = (await json<{ id: string }>(request('POST', `${base()}/tasks`, owner, { title: 'Tagged work' }), 201)).id;
 await json(request('PUT', `${base()}/tasks/${task}/tags/${kept}`, owner));
 const stored = (await json<Detail>(request('GET', `${views()}/${view.id}`, person))).filter;
 const query = (ids: string[]) => ids.map(id => `tagId=${id}`).join('&');
 assert.deepEqual((await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?${query(stored.tagIds)}`, person))).tasks.map(t => t.id), [task]);
 assert.deepEqual((await json<{ tasks: WorkTask[] }>(request('GET', `${base()}/tasks?${query([gone])}`, person))).tasks, []);
});

it('a newer or unreadable stored filter is inapplicable and never cast into version 1', async () => {
 const person = await signIn('views-future'); await join(person);
 const future = randomUUID(), broken = randomUUID();
 const newer = { owner: 'me', status: 'open', tagIds: [], projectId: null, due: 'this-week' };
 await db.owner`insert into saved_views (id, organisation_id, owner_id, name, filter_version, filter)
  values (${future}, ${org}, ${person.user.id}, 'From the future', 2, ${db.owner.json(newer as never)}),
   (${broken}, ${org}, ${person.user.id}, 'Broken', 1, ${db.owner.json({ owner: 'me' } as never)})`;
 const detail = await json<Detail>(request('GET', `${views()}/${future}`, person));
 assert.equal(detail.applicable, false); assert.equal(detail.filterVersion, 2); assert.equal(typeof detail.reason, 'string');
 assert.match(detail.reason!, /newer version/); assert.equal(detail.references, null);
 assert.deepEqual(detail.filter, newer, 'returned as stored, not reduced to version 1');
 const unreadable = await json<Detail>(request('GET', `${views()}/${broken}`, person));
 assert.equal(unreadable.applicable, false); assert.equal(unreadable.filterVersion, 1); assert.deepEqual(unreadable.filter, { owner: 'me' });
 const listed = await json<{ views: View[] }>(request('GET', views(), person));
 assert.deepEqual(listed.views.map(v => [v.name, v.applicable]), [['Broken', false], ['From the future', false]]);
 const renamed = await json<View>(patch(person, future, { expectedRevision: 1, name: 'Still from the future' }));
 assert.equal(renamed.filterVersion, 2); assert.equal(renamed.applicable, false); assert.deepEqual(renamed.filter, newer);
 assert.equal((await json<Failure>(create(person, { id: future, name: 'Still from the future', filter: filter() }), 409)).code, 'view_id_unavailable');
});

it('lists page by lower(name), id and end with nextOffset null', async () => {
 const pager = await signIn('views-pager'); await join(pager);
 for (const name of ['b view', 'A view', 'c view']) await newView(pager, name);
 const first = await json<{ views: View[]; nextOffset: number | null }>(request('GET', `${views()}?limit=2`, pager));
 assert.deepEqual(first.views.map(v => v.name), ['A view', 'b view']); assert.equal(first.nextOffset, 2);
 const last = await json<{ views: View[]; nextOffset: number | null }>(request('GET', `${views()}?limit=2&offset=2`, pager));
 assert.deepEqual(last.views.map(v => v.name), ['c view']); assert.equal(last.nextOffset, null);
 const beyond = await json<{ views: View[]; nextOffset: number | null }>(request('GET', `${views()}?offset=1000000`, pager));
 assert.deepEqual(beyond, { views: [], nextOffset: null });
 for (const query of ['limit=0', 'limit=51', 'offset=-1', 'offset=1000001', 'limit=abc', 'owner=all', 'limit=1&limit=2', 'offset=0&offset=50'])
  assert.equal((await request('GET', `${views()}?${query}`, pager)).status, 400, query);
});

it('an unexpected audit unique violation remains a server error and rolls the view write back', async () => {
 await db.owner.unsafe(`create function fail_view_audit() returns trigger language plpgsql as $$ begin
  if new.action = 'saved_view.created' then raise exception 'forced audit failure' using errcode = '23505'; end if; return new; end $$;
  create trigger fail_view_audit before insert on audit_events for each row execute function fail_view_audit()`);
 const id = randomUUID();
 try { assert.equal((await create(member, { id, name: 'Rollback proof', filter: filter() })).status, 500); }
 finally { await db.owner.unsafe('drop trigger fail_view_audit on audit_events; drop function fail_view_audit()'); }
 assert.equal(await row(id), undefined);
});

it('an export carries only the exporter’s own live views, and audit rows carry identity only', async () => {
 const exporterView = await newView(owner, 'Owner export view', filter({ owner: 'all' }));
 const ownerTombstone = await newView(owner, 'Owner deleted view');
 await json(remove(owner, ownerTombstone.id, 1));
 const memberView = await newView(member, 'Member secret export view', filter({ tagIds: [await makeTag('Export secret tag')] }));
 const lifecycle = new OrganisationLifecycle(db.app);
 const exportAs = async (person: Person) => {
  const lines: { table?: string; row?: Record<string, unknown>; kind?: string; notes?: string[]; counts?: Record<string, number> }[] = [];
  for await (const line of lifecycle.export({ userId: person.user.id, requestId: 'views-export' }, org)) lines.push(JSON.parse(line));
  // The footer counts the rows actually exported: this person's own live views.
  assert.equal(lines[lines.length - 1]!.counts!.saved_views, lines.filter(l => l.table === 'saved_views').length);
  return lines;
 };
 const lines = await exportAs(owner);
 assert.match(lines[0]!.notes!.join(' '), /not a complete backup of personal views/);
 const exported = lines.filter(l => l.table === 'saved_views').map(l => l.row!);
 assert.ok(exported.length >= 1);
 assert.ok(exported.every(r => r.ownerId === owner.user.id && r.deletedAt === null && r.name !== null), 'only the owner’s own live views');
 assert.ok(exported.some(r => r.id === exporterView.id));
 assert.ok(!exported.some(r => r.id === ownerTombstone.id || r.id === memberView.id));
 const text = lines.map(l => JSON.stringify(l)).join('\n');
 assert.ok(!text.includes('Member secret export view'), 'another member’s view name never leaves');
 assert.ok(!text.includes('Owner deleted view'));
 const audits = lines.filter(l => l.table === 'audit_events' && String(l.row!.action).startsWith('saved_view.')).map(l => l.row!);
 assert.ok(audits.length >= 3);
 for (const audit of audits) assert.deepEqual(Object.keys(audit.detail as object).sort(), ['filterVersion', 'revision', 'viewId']);
 // An admin can export too; they get their own views, never the owner's or the member's.
 const adminView = await newView(admin, 'Admin own view');
 const adminRows = (await exportAs(admin)).filter(l => l.table === 'saved_views').map(l => l.row!);
 assert.deepEqual(adminRows.map(r => r.id), [adminView.id]);
});

it('membership, account and organisation deletion remove views and tombstones by cascade without a delete grant', async () => {
 const [privileges] = await db.owner<{ del: boolean; sel: boolean; ins: boolean; upd: boolean }[]>`select
  has_table_privilege('app', 'saved_views', 'DELETE') as del, has_table_privilege('app', 'saved_views', 'SELECT') as sel,
  has_table_privilege('app', 'saved_views', 'INSERT') as ins, has_table_privilege('app', 'saved_views', 'UPDATE') as upd`;
 assert.deepEqual(privileges, { del: false, sel: true, ins: true, upd: true });

 const departed = await signIn('views-departed'); await join(departed);
 const live = await newView(departed, 'Departed live'); const dead = await newView(departed, 'Departed dead');
 await json(remove(departed, dead.id, 1));
 await asApp(owner, tx => tx`delete from memberships where organisation_id = ${org} and user_id = ${departed.user.id}`);
 assert.equal((await db.owner`select * from saved_views where id in ${db.owner([live.id, dead.id])}`).length, 0);

 const leaver = await signIn('views-leaver'); await join(leaver);
 const leaverLive = await newView(leaver, 'Leaver live'); const leaverDead = await newView(leaver, 'Leaver dead');
 await json(remove(leaver, leaverDead.id, 1));
 await db.app`delete from users where id = ${leaver.user.id}`;
 assert.equal((await db.owner`select * from memberships where user_id = ${leaver.user.id}`).length, 0);
 assert.equal((await db.owner`select * from saved_views where id in ${db.owner([leaverLive.id, leaverDead.id])}`).length, 0);

 // Delete only the seeded second test tenant, holding the deleting owner's and another member's private views.
 const doomed = await newView(outsider, 'Doomed live', filter(), otherOrg);
 const doomedDead = await newView(outsider, 'Doomed dead', filter(), otherOrg);
 await json(request('DELETE', `${views(otherOrg)}/${doomedDead.id}?expectedRevision=1`, outsider));
 const colleague = await signIn('views-other-member'); await join(colleague, 'member', otherOrg);
 const colleagueLive = await newView(colleague, 'Colleague private', filter(), otherOrg);
 const colleagueDead = await newView(colleague, 'Colleague deleted', filter(), otherOrg);
 await json(request('DELETE', `${views(otherOrg)}/${colleagueDead.id}?expectedRevision=1`, colleague));
 const deletionIds = [doomed.id, doomedDead.id, colleagueLive.id, colleagueDead.id];
 assert.equal((await db.owner`select id from saved_views where organisation_id = ${otherOrg} and id in ${db.owner(deletionIds)}`).length, 4);
 const deleted = await new OrganisationLifecycle(db.app).delete({ userId: outsider.user.id, email: 'views-outsider@example.test', requestId: 'views-delete' }, otherOrg, 'Other business');
 // Row security would count only the deleting owner's views, so saved views are left out of the totals, not under-counted.
 assert.ok(!('saved_views' in deleted.rowCounts)); assert.equal(deleted.rowCounts.memberships, 2);
 const [record] = await db.owner<{ rowCounts: Record<string, number> }[]>`select row_counts from organisation_deletions where deleted_organisation_id = ${otherOrg}`;
 assert.ok(!('saved_views' in record!.rowCounts));
 assert.equal((await db.owner`select * from saved_views where organisation_id = ${otherOrg}`).length, 0, 'the cascade still removes every member’s views and tombstones');
 for (const id of deletionIds) assert.equal(await row(id), undefined);
 assert.ok((await db.owner`select * from saved_views where organisation_id = ${org}`).length > 0, 'another tenant’s views are untouched');
});
