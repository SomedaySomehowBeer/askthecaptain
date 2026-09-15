import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from './app.ts';
import type { IdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { SeriesRoutine, startSeriesSchedule } from './commitments/routine.ts';
import { CommitmentsService, type Overview, type Project, type Series, type Task } from './commitments/service.ts';
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

it('a new organisation has its Obligations deadline book and nothing else', async () => {
	const overview = await body<Overview>(await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token), 200);
	assert.deepEqual(overview.projects.map((p) => [p.name, p.systemKind]), [['Obligations', 'obligations']]);
	assert.deepEqual(overview.tasks, []); assert.deepEqual(overview.series, []);
	assert.equal(overview.today, todayIn('Australia/Perth')); assert.equal(overview.timezone, 'Australia/Perth');
});

it('tasks land in Obligations by default, are completed with who and when, and are audited', async () => {
	const task = await body<Task>(await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: '  Send updated price list ', due: '2026-10-01' }), 201);
	assert.equal(task.title, 'Send updated price list'); assert.equal(task.due, '2026-10-01'); assert.equal(task.status, 'open'); assert.equal(task.sourceKind, 'person');
	assert.equal(task.ownerName, null);
	const done = await body<Task>(await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { status: 'done', ownerId: owner.user.id }), 200);
	assert.equal(done.status, 'done'); assert.equal(done.completedBy, owner.user.id); assert.ok(done.completedAt); assert.equal(done.ownerName, 'Olive Owner');
	const reopened = await body<Task>(await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { status: 'open', due: null }), 200);
	assert.equal(reopened.completedBy, null); assert.equal(reopened.completedAt, null); assert.equal(reopened.due, null);
	const actions = (await db.owner`select action from audit_events where organisation_id = ${orgId} and subject_id = ${task.id} order by created_at`).map((row) => row.action);
	assert.deepEqual(actions, ['task.created', 'task.completed', 'task.updated']);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: '   ' })).status, 400);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'x', due: 'next week' })).status, 400);
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/tasks/${task.id}`, owner.token, { ownerId: '00000000-0000-7000-8000-000000000000' })).status, 400, 'owner must be a member');
});

it('projects are created, edited and archived; the Obligations project cannot be archived', async () => {
	const project = await body<Project>(await json('POST', `/v1/organisations/${orgId}/projects`, owner.token, { name: 'Production', stages: ['Planned', ' Brewing ', ''] }), 201);
	assert.deepEqual(project.stages, ['Planned', 'Brewing']);
	const archived = await body<Project>(await json('PATCH', `/v1/organisations/${orgId}/projects/${project.id}`, owner.token, { description: 'Brew days', archived: true }), 200);
	assert.ok(archived.archivedAt); assert.equal(archived.description, 'Brew days');
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'Package batch 42', projectId: project.id })).status, 400, 'no tasks in an archived project');
	const restored = await body<Project>(await json('PATCH', `/v1/organisations/${orgId}/projects/${project.id}`, owner.token, { archived: false }), 200);
	assert.equal(restored.archivedAt, null);
	const overview = await body<Overview>(await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token), 200);
	const obligations = overview.projects.find((p) => p.systemKind === 'obligations')!;
	assert.equal((await json('PATCH', `/v1/organisations/${orgId}/projects/${obligations.id}`, owner.token, { archived: true })).status, 400);
});

it('a series materialises its current occurrence once, and editing it changes future occurrences only', async () => {
	const series = await body<Series>(await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Excise return', recurrence: 'monthly', anchor: '2026-01-01', dueOffsetDays: 21, evidenceRequired: true }), 201);
	const today = todayIn('Australia/Perth');
	assert.equal(series.nextDue !== null, true);
	let overview = await body<Overview>(await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token), 200);
	const occurrences = overview.tasks.filter((t) => t.seriesId === series.id);
	assert.equal(occurrences.length, 1, 'exactly one occurrence after creation and a read');
	const [occurrence] = occurrences;
	assert.equal(occurrence!.sourceKind, 'series'); assert.equal(occurrence!.periodStart, `${today.slice(0, 7)}-01`); assert.match(occurrence!.title, /^Excise return — /);
	assert.equal(occurrence!.projectId, overview.projects.find((p) => p.systemKind === 'obligations')!.id);
	const renamed = await body<Series>(await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { title: 'Excise duty return' }), 200);
	assert.equal(renamed.title, 'Excise duty return');
	overview = await body<Overview>(await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token), 200);
	assert.equal(overview.tasks.find((t) => t.id === occurrence!.id)!.title, occurrence!.title, 'the existing occurrence keeps its title');
	// The duty needs evidence: completing without any is refused, with some it goes through.
	const refused = await json('PATCH', `/v1/organisations/${orgId}/tasks/${occurrence!.id}`, owner.token, { status: 'done' });
	assert.equal(refused.status, 400); assert.equal(((await refused.json()) as { code: string }).code, 'evidence_required');
	assert.equal(overview.tasks.find((t) => t.id === occurrence!.id)!.evidenceRequired, true);
	await body(await json('POST', `/v1/organisations/${orgId}/tasks/${occurrence!.id}/evidence`, owner.token, { kind: 'mail', reference: 'gmail:18f3', label: 'ATO confirmation' }), 201);
	assert.equal((await body<Task>(await json('PATCH', `/v1/organisations/${orgId}/tasks/${occurrence!.id}`, owner.token, { status: 'done' }), 200)).status, 'done');
	const paused = await body<Series>(await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { paused: true }), 200);
	assert.ok(paused.pausedAt); assert.equal(paused.nextDue, null);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Odd', recurrence: 'custom', anchor: '2026-01-01' })).status, 400, 'custom needs everyMonths');
	assert.equal((await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Odd', recurrence: 'monthly', anchor: '2026-02-30' })).status, 400, 'anchor must be a calendar date');
});

it('a series anchored in the future produces nothing yet', async () => {
	const series = await body<Series>(await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Liquor licence renewal', recurrence: 'yearly', anchor: '2999-01-01' }), 201);
	assert.equal(series.nextDue, '2999-12-31');
	const overview = await body<Overview>(await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token), 200);
	assert.equal(overview.tasks.filter((t) => t.seriesId === series.id).length, 0);
});

it('evidence is attached to a task and removed', async () => {
	const task = await body<Task>(await json('POST', `/v1/organisations/${orgId}/tasks`, owner.token, { title: 'Pay the excise' }), 201);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks/${task.id}/evidence`, owner.token, { kind: 'url', reference: 'ftp://nope' })).status, 400);
	const evidence = await body<{ id: string }>(await json('POST', `/v1/organisations/${orgId}/tasks/${task.id}/evidence`, owner.token, { kind: 'url', reference: 'https://ato.example/receipt/1', label: 'Receipt' }), 201);
	const overview = await body<Overview>(await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token), 200);
	assert.deepEqual(overview.tasks.find((t) => t.id === task.id)!.evidence.map((e) => [e.kind, e.label]), [['url', 'Receipt']]);
	assert.equal((await json('DELETE', `/v1/organisations/${orgId}/evidence/${evidence.id}`, owner.token)).status, 200);
	assert.equal((await json('DELETE', `/v1/organisations/${orgId}/evidence/${evidence.id}`, owner.token)).status, 404);
});

it('a stranger cannot see or touch another organisation\'s commitments', async () => {
	const stranger = await signIn({ subject: 'g-9', email: 'stranger@example.com', name: 'Sam' });
	assert.equal((await json('GET', `/v1/organisations/${orgId}/commitments`, stranger.token)).status, 404);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/tasks`, stranger.token, { title: 'Mine now' })).status, 404);
	assert.equal((await json('POST', `/v1/organisations/${orgId}/series`, stranger.token, { title: 'x', recurrence: 'monthly', anchor: '2026-01-01' })).status, 404);
	assert.equal((await json('GET', `/v1/organisations/${orgId}/commitments`)).status, 401);
});

it('the materialise-series routine creates the next period once, skips paused series, and the tab does not', async () => {
	const routine = new SeriesRoutine(db.app, commitments);
	const series = await body<Series>(await json('POST', `/v1/organisations/${orgId}/series`, owner.token, { title: 'Order cans', recurrence: 'monthly', anchor: '2026-01-01' }), 201);
	assert.ok((await routine.organisations()).includes(orgId), 'an organisation with an active series is discovered');
	// A new period opens: the routine creates that period's occurrence, exactly once.
	const nextMonth = '2099-03-15';
	assert.equal(await routine.run(orgId, nextMonth), 1);
	assert.equal(await routine.run(orgId, nextMonth), 0);
	let overview = await body<Overview>(await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token), 200);
	const mine = overview.tasks.filter((t) => t.seriesId === series.id).map((t) => t.periodStart).sort();
	assert.deepEqual(mine, [`${todayIn('Australia/Perth').slice(0, 7)}-01`, '2099-03-01']);
	// Reading the tab in a later period creates nothing; only the routine does.
	await body<Series>(await json('PATCH', `/v1/organisations/${orgId}/series/${series.id}`, owner.token, { paused: true }), 200);
	assert.equal(await routine.run(orgId, '2099-05-15'), 0, 'a paused series produces nothing');
	overview = await body<Overview>(await json('GET', `/v1/organisations/${orgId}/commitments`, owner.token), 200);
	assert.equal(overview.tasks.filter((t) => t.seriesId === series.id).length, 2);
	const stop = startSeriesSchedule({ organisations: async () => [], run: async () => 0 }, true);
	await stop();
});
