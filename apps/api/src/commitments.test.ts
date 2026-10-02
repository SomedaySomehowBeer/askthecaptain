import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from './app.ts';
import type { IdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { SeriesRoutine, startSeriesSchedule } from './commitments/routine.ts';
import { CommitmentsService, type Series, type Task } from './commitments/service.ts';
import { todayIn } from './commitments/series.ts';
import { OrganisationService } from './organisations/service.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness; let app: ReturnType<typeof createApp>; let commitments: CommitmentsService;
const google: IdentityProvider & { next: { subject: string; email: string; name: string } } = {
	next: { subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' },
	authorizationUrl: ({ state }) => `https://google.test/auth?state=${state}`,
	async exchange() { return google.next; }
};
const json = (method: string, path: string, token?: string, body?: unknown) => app.request(path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
async function signIn(identity: { subject: string; email: string; name: string }) {
	google.next = identity;
	const start = await app.request('/auth/google/start');
	const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
	const callback = await app.request(`/auth/google/callback?code=abc&state=${state}`);
	const code = new URL(callback.headers.get('location')!).searchParams.get('code')!;
	return (await (await json('POST', '/auth/session/exchange', undefined, { code })).json()) as { token: string; user: { id: string } };
}
const body = async <T>(response: Response, status: number): Promise<T> => { assert.equal(response.status, status, await response.clone().text()); return (await response.json()) as T; };

let owner: { token: string; user: { id: string } }; let orgId: string;
before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	app = createApp({ db: db.app, auth: new AuthService(db.app, google, { appUrl: 'https://app.example.test', sessionTtlDays: 30 }), organisations: new OrganisationService(db.app), commitments: (commitments = new CommitmentsService(db.app)) });
	owner = await signIn({ subject: 'g-1', email: 'owner@example.com', name: 'Olive Owner' });
	orgId = (await body<{ id: string }>(await json('POST', '/v1/organisations', owner.token, { name: 'Harbour Brewing', timezone: 'Australia/Perth' }), 201)).id;
});
after(async () => { await db?.close(); });

type Detail = { task: Task; tags: { items: { id: string; name: string }[] }; checklist: { tasks: Task[]; nextOffset: number | null }; evidenceNextOffset: number | null; today: string; timezone: string };
type WorkRow = { id: string; seriesId: string | null; periodStart?: string; title: string; revision: number };
const detail = (id: string, token = owner.token) => json('GET', `/v1/organisations/${orgId}/tasks/${id}`, token);
const occurrencesOf = async (seriesId: string) => (await body<{ tasks: WorkRow[] }>(await json('GET', `/v1/organisations/${orgId}/tasks?seriesId=${seriesId}&limit=100`, owner.token), 200)).tasks;
const revisionOf = async (id: string) => (await body<Detail>(await detail(id), 200)).task.revision;

it('a new organisation has no tag, the retired overview and project routes are gone, and reading creates nothing', async () => {
	assert.equal((await json('GET', `/v1/organisations/${orgId}/projects`, owner.token)).status, 404, 'projects are tags since 0046');
	const retired = await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token);
	assert.equal(retired.status, 410); assert.equal(((await retired.json()) as { code: string }).code, 'legacy_feature_retired');
	assert.equal((await db.owner`select count(*)::int as n from tags where organisation_id = ${orgId}`)[0]!.n, 0);
	assert.deepEqual((await body<{ series: Series[] }>(await json('GET', `/v1/organisations/${orgId}/series`, owner.token), 200)).series, []);
});

it('a task stands alone with its own thread, is completed with who and when, and is audited', async () => {
	const task = await body<Task>(await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: '  Send updated price list ', due: '2026-10-01' }), 201);
	assert.ok(!('projectId' in task), 'a task has no project'); assert.equal(task.revision, 1);
	assert.equal((await db.owner`select count(*)::int as n from threads where task_id = ${task.id}`)[0]!.n, 1, 'its record thread');
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'With a project', projectId: task.id })).status, 400, 'projectId is retired');
	assert.equal(task.title, 'Send updated price list'); assert.equal(task.due, '2026-10-01'); assert.equal(task.status, 'open'); assert.equal(task.sourceKind, 'person');
	assert.equal(task.ownerName, null);
	const done = await body<Task>(await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { expectedRevision: 1, status: 'done', ownerId: owner.user.id }), 200);
	assert.equal(done.status, 'done'); assert.equal(done.completedBy, owner.user.id); assert.ok(done.completedAt); assert.equal(done.ownerName, 'Olive Owner'); assert.equal(done.revision, 2);
	const reopened = await body<Task>(await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { expectedRevision: 2, status: 'open', due: null }), 200);
	assert.equal(reopened.completedBy, null); assert.equal(reopened.completedAt, null); assert.equal(reopened.due, null);
	// The journal is the audit record (0047): three change sets by the owner, their typed changes, three change lines.
	const sets = await db.owner<{ actorId: string; actorKind: string; causeKind: string; changes: string[] }[]>`select s.actor_id, s.actor_kind, s.cause_kind,
		array_agg(c.operation || coalesce(':' || c.field, '') order by c.field nulls first) as changes
		from change_sets s join record_changes c on c.change_set_id = s.id where c.record_kind = 'task' and c.record_id = ${task.id} group by s.id order by s.id`;
	assert.deepEqual(sets.map((x) => [x.actorId, x.actorKind, x.causeKind]), Array(3).fill([owner.user.id, 'person', 'request']));
	assert.deepEqual(sets.map((x) => x.changes), [['create'], ['update:completed_at', 'update:completed_by', 'update:owner_id', 'update:status'], ['update:completed_at', 'update:completed_by', 'update:due', 'update:status']]);
	const [due] = await db.owner<{ before: unknown; after: unknown }[]>`select before, after from record_changes where record_id = ${task.id} and field = 'due'`;
	assert.deepEqual(due, { before: '2026-10-01', after: null }, 'typed before and after');
	assert.deepEqual((await db.owner`select m.kind from thread_messages m join threads t on t.id = m.thread_id where t.task_id = ${task.id} order by m.seq`).map((m) => m.kind),
		['change', 'change', 'change'], 'one change line per change set in the task’s thread');
	assert.equal((await db.owner`select 1 from audit_events where subject_id = ${task.id}`).length, 0, 'no business audit row: the change set is the record');
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: '   ' })).status, 400);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'x', due: 'next week' })).status, 400);
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { expectedRevision: 3, ownerId: '00000000-0000-7000-8000-000000000000' })).status, 400, 'owner must be a member');
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { title: 'No precondition' })).status, 400, 'an edit must name its revision');
});

it('a series materialises its current occurrence once, and editing it changes future occurrences only', async () => {
	const series = await body<Series>(await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Excise return', recurrence: 'monthly', anchor: '2026-01-01', dueOffsetDays: 21, evidenceRequired: true }), 201);
	const today = todayIn('Australia/Perth');
	assert.equal(series.nextDue !== null, true); assert.equal(series.revision, 1);
	const occurrences = await occurrencesOf(series.id);
	assert.equal(occurrences.length, 1, 'exactly one occurrence after creation and a read');
	const occurrence = (await body<Detail>(await detail(occurrences[0]!.id), 200)).task;
	assert.equal(occurrence.sourceKind, 'series'); assert.equal(occurrence.periodStart, `${today.slice(0, 7)}-01`); assert.match(occurrence.title, /^Excise return — /);
	assert.deepEqual((await body<Detail>(await detail(occurrence.id), 200)).tags.items, [], 'a series without tags makes untagged occurrences');
	const renamed = await body<Series>(await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { expectedRevision: 1, title: 'Excise duty return' }), 200);
	assert.equal(renamed.title, 'Excise duty return'); assert.equal(renamed.revision, 2);
	assert.equal((await body<Series>(await json('GET', `/v1/organisations/${orgId}/series/${series.id}`, owner.token), 200)).title, 'Excise duty return');
	assert.equal((await body<Detail>(await detail(occurrence.id), 200)).task.title, occurrence.title, 'the existing occurrence keeps its title');
	// The duty needs evidence: completing without any is refused, with some it goes through.
	const refused = await json('PATCH', `/v1/organisations/${orgId}/tasks/${occurrence.id}`, owner.token, { expectedRevision: occurrence.revision, status: 'done' });
	assert.equal(refused.status, 400); assert.equal(((await refused.json()) as { code: string }).code, 'evidence_required');
	assert.equal(occurrence.evidenceRequired, true);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks/${occurrence.id}/evidence`, owner.token, { expectedRevision: occurrence.revision, kind: 'mail', reference: 'gmail:18f3' })).status, 400, 'mail evidence is retired');
	await body(await json('POST', `/v1/organisations/${orgId}/tasks/${occurrence.id}/evidence`, owner.token, { expectedRevision: occurrence.revision, kind: 'url', reference: 'https://ato.example/confirmation', label: 'ATO confirmation' }), 201);
	assert.equal((await body<Task>(await json('PATCH', `/v1/organisations/${orgId}/tasks/${occurrence.id}`, owner.token, { expectedRevision: occurrence.revision + 1, status: 'done' }), 200)).status, 'done');
	const paused = await body<Series>(await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { expectedRevision: 2, paused: true }), 200);
	assert.ok(paused.pausedAt); assert.equal(paused.nextDue, null);
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { expectedRevision: 2, paused: false })).status, 409, 'a stale series edit is refused');
	assert.deepEqual((await body<{ series: Series[] }>(await json('GET', `/v1/organisations/${orgId}/series?paused=true`, owner.token), 200)).series.map((s) => s.id), [series.id]);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Odd', recurrence: 'custom', anchor: '2026-01-01' })).status, 400, 'custom needs everyMonths');
	assert.equal((await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Odd', recurrence: 'monthly', anchor: '2026-02-30' })).status, 400, 'anchor must be a calendar date');
});

it('a series anchored in the future produces nothing yet', async () => {
	const series = await body<Series>(await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Liquor licence renewal', recurrence: 'yearly', anchor: '2999-01-01' }), 201);
	assert.equal(series.nextDue, '2999-12-31');
	assert.equal((await occurrencesOf(series.id)).length, 0);
});

it('evidence is attached and removed against the task revision, and a retried request is refused', async () => {
	const task = await body<Task>(await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'Pay the excise' }), 201);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks/${task.id}/evidence`, owner.token, { expectedRevision: 1, kind: 'url', reference: 'ftp://nope' })).status, 400);
	const add = { expectedRevision: 1, kind: 'url', reference: 'https://ato.example/receipt/1', label: 'Receipt' };
	const evidence = await body<{ id: string }>(await json('POST', `/v1/organisations/${orgId}/tasks/${task.id}/evidence`, owner.token, add), 201);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks/${task.id}/evidence`, owner.token, add)).status, 409, 'a retry after an uncertain response does not attach a second copy');
	const read = await body<Detail>(await detail(task.id), 200);
	assert.deepEqual(read.task.evidence.map((e) => [e.kind, e.label]), [['url', 'Receipt']]); assert.equal(read.task.evidenceCount, 1); assert.equal(read.task.revision, 2);
	assert.equal((await json('DELETE', `/v1/organisations/${orgId}/evidence/${evidence.id}?expectedRevision=1`, owner.token)).status, 409);
	assert.equal((await json('DELETE', `/v1/organisations/${orgId}/evidence/${evidence.id}`, owner.token)).status, 400, 'removal names the task revision');
	assert.equal((await json('DELETE', `/v1/organisations/${orgId}/evidence/${evidence.id}?expectedRevision=2`, owner.token)).status, 200);
	assert.equal((await json('DELETE', `/v1/organisations/${orgId}/evidence/${evidence.id}?expectedRevision=3`, owner.token)).status, 404);
	assert.equal(await revisionOf(task.id), 3);
});

it('work options list top-level tasks and take no project', async () => {
	const options = (query: string) => json('GET', `/v1/organisations/${orgId}/work/options?${query}`, owner.token);
	const labels = async (query: string) => (await body<{ tasks: { items: { label: string }[] } }>(await options(query), 200)).tasks.items;
	assert.ok((await labels('')).length > 0);
	assert.ok((await labels('q=price')).every((t) => /price/i.test(t.label)));
	for (const bad of ['projectId=none', 'projectOffset=0']) assert.equal((await options(bad)).status, 400, bad);
});

it('a series carries tags, and each occurrence receives them on its thread in the same transaction', async () => {
	const tag = await body<{ id: string }>(await json('POST', `/v1/organisations/${orgId}/tags`, owner.token, { name: 'Compliance' }), 201);
	const series = await body<Series>(await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'BAS', recurrence: 'quarterly', anchor: '2026-01-01', tagIds: [tag.id] }), 201);
	assert.deepEqual(series.tagIds, [tag.id]); assert.ok(!('projectId' in series));
	const [occurrence] = await occurrencesOf(series.id);
	assert.deepEqual((await body<Detail>(await detail(occurrence!.id), 200)).tags.items.map((t) => t.id), [tag.id], 'the occurrence’s thread carries the series’ tags');
	const thread = (await db.owner`select id from threads where task_id = ${occurrence!.id}`)[0]!.id;
	assert.deepEqual((await db.owner`select action from chat_audit_events where thread_id = ${thread}`).map((r) => r.action), ['chat.tag_added'], 'a person’s thread write');
	// The routine (no person) does the same, under its own change set: the system, caused by the routine.
	const routine = new SeriesRoutine(db.app, commitments);
	assert.ok(await routine.run(orgId, '2099-04-15') >= 1);
	const later = (await occurrencesOf(series.id)).find((t) => t.id !== occurrence!.id)!;
	assert.deepEqual((await body<Detail>(await detail(later.id), 200)).tags.items.map((t) => t.id), [tag.id]);
	const [materialised] = await db.owner<{ actorId: string | null; actorKind: string; causeKind: string; causeId: string; changes: string[] }[]>`select s.actor_id, s.actor_kind,
		s.cause_kind, s.cause_id, array_agg(c.operation || coalesce(':' || c.item_id, '') order by c.id) as changes
		from change_sets s join record_changes c on c.change_set_id = s.id where c.record_id = ${later.id} group by s.id`;
	assert.deepEqual(materialised, { actorId: null, actorKind: 'system', causeKind: 'routine', causeId: 'series.materialise', changes: ['create', `attach:${tag.id}`] });
	assert.equal((await db.owner`select author_id from thread_messages m join threads t on t.id = m.thread_id where t.task_id = ${later.id} and m.kind = 'change'`)[0]!.authorId, null,
		'the system’s change line has no author');
	// Editing the series' tags changes future occurrences only.
	const other = await body<{ id: string }>(await json('POST', `/v1/organisations/${orgId}/tags`, owner.token, { name: 'Tax' }), 201);
	const edited = await body<Series>(await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { expectedRevision: series.revision, tagIds: [other.id] }), 200);
	assert.deepEqual(edited.tagIds, [other.id]);
	assert.deepEqual((await body<Detail>(await detail(later.id), 200)).tags.items.map((t) => t.id), [tag.id]);
	await body(await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { expectedRevision: edited.revision, paused: true }), 200);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Odd', recurrence: 'monthly', anchor: '2026-01-01', tagIds: ['00000000-0000-4000-8000-000000000000'] })).status, 404);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Odd', recurrence: 'monthly', anchor: '2026-01-01', projectId: tag.id })).status, 400, 'projectId is retired');
});

it('a stranger cannot see or touch another organisation\'s work', async () => {
	const stranger = await signIn({ subject: 'g-9', email: 'stranger@example.com', name: 'Sam' });
	const [task] = await db.owner`select id from tasks where organisation_id = ${orgId} limit 1`;
	for (const path of ['commitments', 'projects', 'series', 'work/options', `tasks/${task!.id}`])
		assert.equal((await json('GET', `/v1/organisations/${orgId}/${path}`, stranger.token)).status, 404, path);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, stranger.token, { title: 'Mine now' })).status, 404);
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/tasks/${task!.id}`, stranger.token, { expectedRevision: 1, title: 'Mine now' })).status, 404);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/series`, stranger.token, { title: 'x', recurrence: 'monthly', anchor: '2026-01-01' })).status, 404);
	assert.equal((await json('GET', `/v1/organisations/${orgId}/commitments`)).status, 401);
});

it('the materialise-series routine creates the next period once, skips paused series, and reading does not', async () => {
	const routine = new SeriesRoutine(db.app, commitments);
	const series = await body<Series>(await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Order cans', recurrence: 'monthly', anchor: '2026-01-01' }), 201);
	assert.ok((await routine.organisations()).includes(orgId), 'an organisation with an active series is discovered');
	// A new period opens: the routine creates that period's occurrence, exactly once.
	const nextMonth = '2099-03-15';
	assert.equal(await routine.run(orgId, nextMonth), 1);
	assert.equal(await routine.run(orgId, nextMonth), 0);
	const periods = async () => Promise.all((await occurrencesOf(series.id)).map(async (t) => (await body<Detail>(await detail(t.id), 200)).task.periodStart));
	assert.deepEqual((await periods()).sort(), [`${todayIn('Australia/Perth').slice(0, 7)}-01`, '2099-03-01']);
	// Reading in a later period creates nothing; only the routine does.
	await body<Series>(await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { expectedRevision: 1, paused: true }), 200);
	assert.equal(await routine.run(orgId, '2099-05-15'), 0, 'a paused series produces nothing');
	assert.equal((await occurrencesOf(series.id)).length, 2);
	const stop = startSeriesSchedule({ organisations: async () => [], run: async () => 0 }, true);
	await stop();
});
