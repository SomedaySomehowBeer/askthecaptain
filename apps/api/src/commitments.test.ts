import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from './app.ts';
import type { IdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { SeriesRoutine, startSeriesSchedule } from './commitments/routine.ts';
import { CommitmentsService, type Project, type Series, type Task } from './commitments/service.ts';
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

type Detail = { task: Task; project: Project | null; checklist: { tasks: Task[]; nextOffset: number | null }; evidenceNextOffset: number | null; today: string; timezone: string };
type WorkRow = { id: string; seriesId: string | null; periodStart?: string; title: string; revision: number };
const detail = (id: string, token = owner.token) => json('GET', `/v1/organisations/${orgId}/tasks/${id}`, token);
const occurrencesOf = async (seriesId: string) => (await body<{ tasks: WorkRow[] }>(await json('GET', `/v1/organisations/${orgId}/tasks?seriesId=${seriesId}&limit=100`, owner.token), 200)).tasks;
const revisionOf = async (id: string) => (await body<Detail>(await detail(id), 200)).task.revision;

it('a new organisation has no project, the retired overview is gone, and reading creates nothing', async () => {
	assert.deepEqual((await body<{ projects: Project[] }>(await json('GET', `/v1/organisations/${orgId}/projects`, owner.token), 200)).projects, []);
	const retired = await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token);
	assert.equal(retired.status, 410); assert.equal(((await retired.json()) as { code: string }).code, 'legacy_feature_retired');
	assert.equal((await db.owner`select count(*)::int as n from projects where organisation_id = ${orgId}`)[0]!.n, 0);
	assert.deepEqual((await body<{ series: Series[] }>(await json('GET', `/v1/organisations/${orgId}/series`, owner.token), 200)).series, []);
});

it('a task without a project stands alone, is completed with who and when, and is audited', async () => {
	const task = await body<Task>(await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: '  Send updated price list ', due: '2026-10-01' }), 201);
	assert.equal(task.projectId, null); assert.equal(task.revision, 1);
	assert.equal((await db.owner`select count(*)::int as n from projects where organisation_id = ${orgId}`)[0]!.n, 0, 'no project is created for it');
	assert.equal(task.title, 'Send updated price list'); assert.equal(task.due, '2026-10-01'); assert.equal(task.status, 'open'); assert.equal(task.sourceKind, 'person');
	assert.equal(task.ownerName, null);
	const done = await body<Task>(await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { expectedRevision: 1, status: 'done', ownerId: owner.user.id }), 200);
	assert.equal(done.status, 'done'); assert.equal(done.completedBy, owner.user.id); assert.ok(done.completedAt); assert.equal(done.ownerName, 'Olive Owner'); assert.equal(done.revision, 2);
	const reopened = await body<Task>(await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { expectedRevision: 2, status: 'open', due: null }), 200);
	assert.equal(reopened.completedBy, null); assert.equal(reopened.completedAt, null); assert.equal(reopened.due, null);
	const actions = (await db.owner`select action from audit_events where organisation_id = ${orgId} and subject_id = ${task.id} order by created_at`).map((row) => row.action);
	assert.deepEqual(actions, ['task.created', 'task.completed', 'task.updated']);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: '   ' })).status, 400);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'x', due: 'next week' })).status, 400);
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { expectedRevision: 3, ownerId: '00000000-0000-7000-8000-000000000000' })).status, 400, 'owner must be a member');
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { title: 'No precondition' })).status, 400, 'an edit must name its revision');
});

it('projects are created, edited, archived and restored with revisions, listed by state, and none is special', async () => {
	const project = await body<Project>(await json('POST', `/v1/organisations/${orgId}/projects`, owner.token, { name: 'Production', stages: ['Planned', ' Brewing ', ''] }), 201);
	assert.deepEqual(project.stages, ['Planned', 'Brewing']); assert.equal(project.revision, 1);
	const archived = await body<Project>(await json('PATCH', `/v1/organisations/${orgId}/projects/${project.id}`, owner.token, { expectedRevision: 1, description: 'Brew days', archived: true }), 200);
	assert.ok(archived.archivedAt); assert.equal(archived.description, 'Brew days'); assert.equal(archived.revision, 2);
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/projects/${project.id}`, owner.token, { expectedRevision: 1, archived: false })).status, 409, 'a stale edit is refused');
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'Package batch 42', projectId: project.id })).status, 400, 'no tasks in an archived project');
	const list = async (state: string) => (await body<{ projects: Project[] }>(await json('GET', `/v1/organisations/${orgId}/projects?state=${state}`, owner.token), 200)).projects.map((p) => p.name);
	assert.deepEqual([await list('active'), await list('archived')], [[], ['Production']]);
	const restored = await body<Project>(await json('PATCH', `/v1/organisations/${orgId}/projects/${project.id}`, owner.token, { expectedRevision: 2, archived: false }), 200);
	assert.equal(restored.archivedAt, null);
	const one = await body<Project>(await json('GET', `/v1/organisations/${orgId}/projects/${project.id}`, owner.token), 200);
	assert.equal(one.revision, 3); assert.ok(!('systemKind' in one), 'projects no longer carry a system kind');
	assert.deepEqual(await list('active'), ['Production']);
});

it('a series materialises its current occurrence once, and editing it changes future occurrences only', async () => {
	const series = await body<Series>(await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Excise return', recurrence: 'monthly', anchor: '2026-01-01', dueOffsetDays: 21, evidenceRequired: true }), 201);
	const today = todayIn('Australia/Perth');
	assert.equal(series.nextDue !== null, true); assert.equal(series.revision, 1);
	const occurrences = await occurrencesOf(series.id);
	assert.equal(occurrences.length, 1, 'exactly one occurrence after creation and a read');
	const occurrence = (await body<Detail>(await detail(occurrences[0]!.id), 200)).task;
	assert.equal(occurrence.sourceKind, 'series'); assert.equal(occurrence.periodStart, `${today.slice(0, 7)}-01`); assert.match(occurrence.title, /^Excise return — /);
	assert.equal(occurrence.projectId, null, 'a series without a project makes standalone occurrences');
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

it('work options take projectId as absent (all), none (standalone) or a UUID, and refuse anything else', async () => {
	const options = (query: string) => json('GET', `/v1/organisations/${orgId}/work/options?${query}`, owner.token);
	const labels = async (query: string) => (await body<{ tasks: { items: { label: string; projectId: string | null }[] } }>(await options(query), 200)).tasks.items;
	assert.ok((await labels('projectId=none')).every((t) => t.projectId === null));
	const [project] = await db.owner`select id from projects where organisation_id = ${orgId} and state = 'active' limit 1`;
	assert.ok((await labels(`projectId=${String(project!.id).toUpperCase()}`)).every((t) => t.projectId === project!.id), 'a UUID in any case');
	assert.ok((await labels('')).length >= (await labels('projectId=none')).length);
	for (const bad of ['projectId=', 'projectId=null', 'projectId=abc']) assert.equal((await options(bad)).status, 400, bad);
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
