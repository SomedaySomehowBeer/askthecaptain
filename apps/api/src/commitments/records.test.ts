import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { TagsService } from '../tags/service.ts';
import { CommitmentsService, type Project } from './service.ts';

// Work record pages (#131, #133 step 5): bounded reads, and every edit of an existing task, project or
// series names the revision it was based on. Runs against a real, freshly migrated Postgres.
const it = databaseUrl ? test : test.skip;
let db: Harness; let c: CommitmentsService;
before(async () => { if (databaseUrl) { db = await freshDatabase(); c = new CommitmentsService(db.app); } });
after(async () => { await db?.close(); });

async function organisation(name = 'Work records') {
	const [o] = await db.owner`insert into organisations (name, timezone) values (${name}, 'Australia/Perth') returning id`;
	const [u, m] = await db.owner`insert into users (email) values (${randomUUID() + '@example.test'}), (${randomUUID() + '@example.test'}) returning id`;
	const org = String(o!.id), actor = { userId: String(u!.id), requestId: randomUUID() }, member = { userId: String(m!.id), requestId: randomUUID() };
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${actor.userId}, 'owner'), (${org}, ${member.userId}, 'member')`;
	const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: org, userId: actor.userId }, fn);
	return { org, actor, member, tx };
}
const pages = { checklistOffset: 0, evidenceOffset: 0, tagOffset: 0, limit: 50 };
const revisionOf = async (table: 'tasks' | 'projects' | 'task_series' | 'equipment_reservations', id: string) =>
	Number((await db.owner.unsafe(`select revision from ${table} where id = $1`, [id]))[0]!.revision);

it('a task detail is bounded and complete: project, parent, series, checklist, evidence and tags page with honest next offsets', async () => {
	const f = await organisation(); const tags = new TagsService(db.app);
	const project = await c.createProject(f.actor, f.org, { name: 'Cellar' });
	const task = await c.createTask(f.actor, f.org, { title: 'Clean the cold room', projectId: project.id });
	for (let i = 0; i < 3; i++) await c.createTask(f.actor, f.org, { title: `Step ${i}`, parentId: task.id, expectedParentRevision: await revisionOf('tasks', task.id) });
	for (let i = 0; i < 3; i++) await c.addEvidence(f.actor, f.org, task.id, { expectedRevision: await revisionOf('tasks', task.id), kind: 'url', reference: `https://example.test/${i}` });
	for (const name of ['Beta', 'alpha', 'Gamma']) await tags.setLink(f.actor, f.org, task.id, (await tags.save(f.actor, f.org, { name })).id, true);

	const first = await c.task(f.actor, f.org, task.id, { ...pages, limit: 2 });
	assert.equal(first.task.revision, 7, 'three checklist items and three evidence changes each moved the task on; tags did not');
	assert.deepEqual([first.task.evidence.length, first.task.evidenceCount, first.evidenceNextOffset], [2, 3, 2]);
	assert.deepEqual([first.checklist.tasks.map((t) => t.title), first.checklist.nextOffset], [['Step 0', 'Step 1'], 2]);
	assert.ok(first.checklist.tasks.every((t) => t.evidence.length === 0 && t.parentId === task.id && t.projectId === project.id));
	assert.deepEqual([first.tags.items.map((t) => t.name), first.tags.nextOffset], [['alpha', 'Beta'], 2]);
	assert.deepEqual([first.project?.id, first.parent, first.series, first.timezone], [project.id, null, null, 'Australia/Perth']);
	const rest = await c.task(f.actor, f.org, task.id, { checklistOffset: 2, evidenceOffset: 2, tagOffset: 2, limit: 2 });
	assert.deepEqual([rest.checklist.tasks.map((t) => t.title), rest.checklist.nextOffset, rest.task.evidence.length, rest.evidenceNextOffset, rest.tags.items.map((t) => t.name), rest.tags.nextOffset],
		[['Step 2'], null, 1, null, ['Gamma'], null]);

	// A checklist item reads on its own, with its parent; a cancelled task in an archived project is still readable.
	const step = first.checklist.tasks[0]!;
	assert.deepEqual((await c.task(f.actor, f.org, step.id, pages)).parent, { id: task.id, title: 'Clean the cold room' });
	await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 7, status: 'cancelled' });
	await c.updateProject(f.actor, f.org, project.id, { expectedRevision: 1, archived: true });
	const cancelled = await c.task(f.actor, f.org, task.id, pages);
	assert.deepEqual([cancelled.task.status, cancelled.project?.state], ['cancelled', 'archived']);
	assert.equal((await c.task(f.actor, f.org, step.id, pages)).task.status, 'cancelled', 'the cascade cancelled its checklist');
	// Reopening a cancelled task is an ordinary revision-checked edit (moving it out of the archived project).
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 8, status: 'open', projectId: null })).status, 'open');
});

it('a stale or retried edit is refused, and of two concurrent edits from the same revision exactly one wins', async () => {
	const f = await organisation();
	const task = await c.createTask(f.actor, f.org, { title: 'Order malt' });
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, title: 'Order pale malt' })).revision, 2);
	await assert.rejects(c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, title: 'Order pale malt' }), { status: 409, code: 'stale_revision' }, 'a retry after an uncertain response');
	const results = await Promise.allSettled([
		c.updateTask(f.actor, f.org, task.id, { expectedRevision: 2, title: 'First' }),
		c.updateTask(f.member, f.org, task.id, { expectedRevision: 2, title: 'Second' })]);
	assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
	assert.equal(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code, 'stale_revision');
	assert.equal(await revisionOf('tasks', task.id), 3);
	const project = await c.createProject(f.actor, f.org, { name: 'Malt' });
	await assert.rejects(c.updateProject(f.actor, f.org, project.id, { expectedRevision: 2, name: 'Grain' }), { code: 'stale_revision' });
	const series = await c.createSeries(f.actor, f.org, { title: 'Stock check', recurrence: 'monthly', anchor: '2026-01-01' });
	await assert.rejects(c.updateSeries(f.actor, f.org, series.id, { expectedRevision: 2, title: 'Count' }), { code: 'stale_revision' });
	// The database moves the revision for every update, whoever writes it, and ignores a supplied value.
	await db.owner`update tasks set revision = 1, title = 'Direct' where id = ${task.id}`;
	assert.equal(await revisionOf('tasks', task.id), 4);
});

it('adding a checklist item names the parent revision and moves it on; item edits and cascades move the items', async () => {
	const f = await organisation();
	const task = await c.createTask(f.actor, f.org, { title: 'Launch the lager' });
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Labels', parentId: task.id }), { code: 'revision_required' });
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Labels', parentId: task.id, expectedParentRevision: 2 }), { code: 'stale_revision' });
	const item = await c.createTask(f.actor, f.org, { title: 'Labels', parentId: task.id, expectedParentRevision: 1 });
	assert.equal(await revisionOf('tasks', task.id), 2, 'the parent snapshot changed');
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Kegs', parentId: task.id, expectedParentRevision: 1 }), { code: 'stale_revision' }, 'a retried add is refused');
	await c.updateTask(f.actor, f.org, item.id, { expectedRevision: 1, status: 'in_progress' });
	assert.deepEqual([await revisionOf('tasks', item.id), await revisionOf('tasks', task.id)], [2, 2], "an item's own edit does not stale its parent's editor");
	const project = await c.createProject(f.actor, f.org, { name: 'Lager' });
	await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 2, projectId: project.id });
	await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 3, status: 'done' });
	const [row] = await db.owner`select project_id, status, revision from tasks where id = ${item.id}`;
	assert.deepEqual([row!.projectId, row!.status, row!.revision], [project.id, 'done', 4], 'the move and the completion each moved the item');
	await assert.rejects(c.updateTask(f.actor, f.org, item.id, { expectedRevision: 2, title: 'Stale' }), { code: 'stale_revision' });
});

it('evidence and completion serialise on the task: a done duty cannot silently lose its last evidence', async () => {
	const f = await organisation();
	const series = await c.createSeries(f.actor, f.org, { title: 'Excise return', recurrence: 'monthly', anchor: '2026-01-01', evidenceRequired: true });
	const [occurrence] = await f.tx((sql) => sql`select id from tasks where series_id = ${series.id}`);
	const id = String(occurrence!.id);
	const evidence = await c.addEvidence(f.actor, f.org, id, { expectedRevision: 1, kind: 'url', reference: 'https://ato.example/1' });
	await assert.rejects(c.addEvidence(f.actor, f.org, id, { expectedRevision: 2, kind: 'mail', reference: 'gmail:1' }), { code: 'evidence_kind_retired' });
	// Race completion against removing the only evidence, from the same revision: one waits for the other's
	// lock and then finds the revision moved, so the task never ends up done without evidence.
	const raced = await Promise.allSettled([
		c.updateTask(f.actor, f.org, id, { expectedRevision: 2, status: 'done' }),
		c.removeEvidence(f.member, f.org, evidence.id, { expectedRevision: 2 })]);
	assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
	const [state] = await db.owner`select status, (select count(*)::int from evidence where task_id = ${id}) as n from tasks where id = ${id}`;
	assert.ok(!(state!.status === 'done' && state!.n === 0), 'never done without its evidence');
	if (state!.status === 'done') {
		await assert.rejects(c.removeEvidence(f.actor, f.org, evidence.id, { expectedRevision: await revisionOf('tasks', id) }), { status: 409, code: 'evidence_required' });
		await c.updateTask(f.actor, f.org, id, { expectedRevision: await revisionOf('tasks', id), status: 'open' });
		await c.removeEvidence(f.actor, f.org, evidence.id, { expectedRevision: await revisionOf('tasks', id) });
	}
	assert.equal((await db.owner`select count(*)::int as n from evidence where task_id = ${id}`)[0]!.n, 0, 'removable once the task is reopened (or if removal won)');
});

it('removed members and other tenants can neither read nor change work, even with a current revision', async () => {
	const f = await organisation(); const other = await organisation('Other business');
	const task = await c.createTask(f.actor, f.org, { title: 'Ours' });
	const project = await c.createProject(f.actor, f.org, { name: 'Ours' });
	const theirs = await c.createTask(other.actor, other.org, { title: 'Theirs' });
	await assert.rejects(c.task(f.actor, f.org, theirs.id, pages), { status: 404 }, "another tenant's task through our organisation");
	await assert.rejects(c.updateTask(f.actor, f.org, theirs.id, { expectedRevision: 1, title: 'Taken' }), { status: 404 });
	await assert.rejects(c.task(other.actor, f.org, task.id, pages), { status: 404 }, 'a stranger to our organisation');
	await assert.rejects(c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, ownerId: other.actor.userId }), { code: 'owner_invalid' });
	await db.owner`update memberships set status = 'removed' where organisation_id = ${f.org} and user_id = ${f.member.userId}`;
	// Each attempt starts only when it is awaited, so no rejection goes unhandled in between.
	for (const attempt of [() => c.task(f.member, f.org, task.id, pages), () => c.projects(f.member, f.org, { state: 'active', offset: 0, limit: 50 }),
		() => c.updateTask(f.member, f.org, task.id, { expectedRevision: 1, title: 'Gone' }), () => c.updateProject(f.member, f.org, project.id, { expectedRevision: 1, name: 'Gone' }),
		() => c.createTask(f.member, f.org, { title: 'Gone' }), () => c.workOptions(f.member, f.org, { projectOffset: 0, taskOffset: 0, limit: 100 })])
		await assert.rejects(attempt(), { status: 404 });
	await assert.rejects(c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, ownerId: f.member.userId }), { code: 'owner_invalid' }, 'a removed member cannot be made the owner');
	assert.equal((await c.task(other.actor, other.org, theirs.id, pages)).task.title, 'Theirs', 'nothing leaked across');
});

it('options, project lists and series lists page and search without hidden truncation', async () => {
	const f = await organisation();
	const names = ['Alpha', 'beta', 'Gamma', '100% juice', 'Archived'];
	const projects: Project[] = [];
	for (const name of names) projects.push(await c.createProject(f.actor, f.org, { name }));
	await c.updateProject(f.actor, f.org, projects[4]!.id, { expectedRevision: 1, archived: true });
	const first = await c.projects(f.actor, f.org, { state: 'active', offset: 0, limit: 2 });
	const second = await c.projects(f.actor, f.org, { state: 'active', offset: 2, limit: 2 });
	assert.deepEqual([first.projects.map((p) => p.name), first.nextOffset, second.projects.map((p) => p.name), second.nextOffset], [['100% juice', 'Alpha'], 2, ['beta', 'Gamma'], null]);
	assert.deepEqual((await c.projects(f.actor, f.org, { state: 'archived', offset: 0, limit: 50 })).projects.map((p) => p.name), ['Archived']);
	assert.deepEqual((await c.projects(f.actor, f.org, { state: 'active', offset: 0, limit: 50, q: '%' })).projects.map((p) => p.name), ['100% juice'], '% is literal');
	assert.deepEqual((await c.projects(f.actor, f.org, { state: 'active', offset: 0, limit: 50, q: 'ALP' })).projects.map((p) => p.name), ['Alpha']);

	await c.createTask(f.actor, f.org, { title: 'Standalone sweep' });
	await c.createTask(f.actor, f.org, { title: 'Sweep in alpha', projectId: projects[0]!.id });
	const hidden = await c.createTask(f.actor, f.org, { title: 'Sweep cancelled' });
	await c.updateTask(f.actor, f.org, hidden.id, { expectedRevision: 1, status: 'cancelled' });
	const inArchived = await f.tx((sql) => sql`insert into tasks (organisation_id, project_id, title) values (${f.org}, ${projects[4]!.id}, 'Sweep archived') returning id`);
	const parent = await c.createTask(f.actor, f.org, { title: 'Parent' });
	await c.createTask(f.actor, f.org, { title: 'Sweep step', parentId: parent.id, expectedParentRevision: 1 });
	const options = await c.workOptions(f.actor, f.org, { projectOffset: 0, taskOffset: 0, limit: 1, q: 'sweep' });
	assert.deepEqual([options.projects.items, options.projects.nextOffset], [[], null]);
	assert.deepEqual([options.tasks.items.map((t) => t.label), options.tasks.nextOffset], [['Standalone sweep'], 1]);
	const next = await c.workOptions(f.actor, f.org, { projectOffset: 0, taskOffset: 1, limit: 1, q: 'sweep' });
	assert.deepEqual([next.tasks.items.map((t) => [t.label, t.projectId]), next.tasks.nextOffset], [[['Sweep in alpha', projects[0]!.id]], null],
		'no cancelled, archived-project or checklist tasks, and the standalone one carries no project');
	assert.ok(inArchived.length === 1);
	const scoped = (projectId: string | null) => c.workOptions(f.actor, f.org, { projectOffset: 0, taskOffset: 0, limit: 100, q: 'sweep', projectId });
	assert.deepEqual((await scoped(null)).tasks.items.map((t) => t.label), ['Standalone sweep'], 'none: standalone tasks only');
	assert.deepEqual((await scoped(projects[0]!.id)).tasks.items.map((t) => t.label), ['Sweep in alpha'], 'a project: its tasks only');
	assert.deepEqual((await scoped(projects[4]!.id)).tasks.items, [], 'an archived project offers no tasks');
	const all = await c.workOptions(f.actor, f.org, { projectOffset: 0, taskOffset: 0, limit: 100 });
	assert.deepEqual(all.projects.items.map((p) => p.label), ['100% juice', 'Alpha', 'beta', 'Gamma']);

	const a = await c.createSeries(f.actor, f.org, { title: 'A check', projectId: projects[0]!.id, recurrence: 'monthly', anchor: '2999-01-01' });
	const b = await c.createSeries(f.actor, f.org, { title: 'B check', recurrence: 'monthly', anchor: '2999-01-01' });
	await c.updateSeries(f.actor, f.org, b.id, { expectedRevision: 1, paused: true });
	const list = (query: { projectId?: string; paused?: boolean; offset?: number; limit?: number }) => c.seriesList(f.actor, f.org, { offset: 0, limit: 50, ...query });
	assert.deepEqual((await list({ projectId: projects[0]!.id })).series.map((s) => s.id), [a.id]);
	assert.deepEqual((await list({ paused: true })).series.map((s) => s.id), [b.id]);
	assert.deepEqual((await list({ paused: false })).series.map((s) => s.id), [a.id]);
	const page = await list({ limit: 1 });
	assert.deepEqual([page.series.map((s) => s.title), page.nextOffset], [['A check'], 1]);
	assert.equal((await c.seriesDetail(f.actor, f.org, b.id)).revision, 2);
	await assert.rejects(c.seriesDetail(f.actor, f.org, randomUUID()), { status: 404 });
	await assert.rejects(c.project(f.actor, f.org, randomUUID()), { status: 404 });
});

it('Work lists a series or project explicitly even when its project is archived, and never by default', async () => {
	const f = await organisation(); const tags = new TagsService(db.app);
	const project = await c.createProject(f.actor, f.org, { name: 'Seasonal' });
	const series = await c.createSeries(f.actor, f.org, { title: 'Clean lines', projectId: project.id, recurrence: 'monthly', anchor: '2026-01-01' });
	await c.updateProject(f.actor, f.org, project.id, { expectedRevision: 1, archived: true });
	assert.equal((await tags.work(f.actor, f.org, {})).tasks.length, 0, 'the default Work list excludes archived work');
	const bySeries = (await tags.work(f.actor, f.org, { seriesId: series.id })).tasks;
	assert.equal(bySeries.length, 1); assert.equal(bySeries[0]!.seriesId, series.id); assert.equal(bySeries[0]!.revision, 1);
	assert.equal((await tags.work(f.actor, f.org, { projectId: project.id })).tasks.length, 1);
});

it('moving a task moves its confirmed booking and both revisions; archiving a project moves its revision', async () => {
	const f = await organisation();
	const [equipment] = await db.owner`insert into equipment (organisation_id, name) values (${f.org}, 'Fermenter') returning id`;
	const project = await c.createProject(f.actor, f.org, { name: 'Autumn' });
	const task = await c.createTask(f.actor, f.org, { title: 'Brew', projectId: project.id });
	const [booking] = await db.owner`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, project_id, task_id, created_by)
		values (gen_random_uuid(), ${f.org}, ${equipment!.id}, 'Brew', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', ${project.id}, ${task.id}, ${f.actor.userId}) returning id`;
	const moved = await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, projectId: null });
	assert.equal(moved.revision, 2);
	const [after] = await db.owner`select project_id, revision from equipment_reservations where id = ${booking!.id}`;
	assert.deepEqual([after!.projectId, after!.revision], [null, 2]);
	assert.equal((await c.updateProject(f.actor, f.org, project.id, { expectedRevision: 1, archived: true })).revision, 2);
});

it("a series' evidence rule belongs to each occurrence when it is made; editing the series changes future ones only", async () => {
	const f = await organisation();
	const series = await c.createSeries(f.actor, f.org, { title: 'Licence check', recurrence: 'monthly', anchor: '2026-01-01', evidenceRequired: true });
	const [current] = await f.tx((sql) => sql`select id from tasks where series_id = ${series.id}`);
	await c.updateSeries(f.actor, f.org, series.id, { expectedRevision: 1, evidenceRequired: false });
	const existing = await c.task(f.actor, f.org, String(current!.id), pages);
	assert.equal(existing.task.evidenceRequired, true, 'the existing occurrence keeps the rule it was made with');
	await assert.rejects(c.updateTask(f.actor, f.org, existing.task.id, { expectedRevision: existing.task.revision, status: 'done' }), { code: 'evidence_required' });
	await c.materialise(f.org, '2099-03-15');
	const [next] = await f.tx((sql) => sql`select evidence_required from tasks where series_id = ${series.id} and period_start = '2099-03-01'`);
	assert.equal(next!.evidenceRequired, false, 'the next occurrence follows the edited series');
});

it("a task, series or project whose owner has left stays editable without re-choosing the owner; a new owner must be active", async () => {
	const f = await organisation();
	const task = await c.createTask(f.actor, f.org, { title: 'Owned', ownerId: f.member.userId });
	const series = await c.createSeries(f.actor, f.org, { title: 'Owned series', ownerId: f.member.userId, recurrence: 'monthly', anchor: '2999-01-01' });
	const project = await c.createProject(f.actor, f.org, { name: 'Owned project', ownerId: f.member.userId });
	await db.owner`update memberships set status = 'removed' where organisation_id = ${f.org} and user_id = ${f.member.userId}`;
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: 1, ownerId: f.member.userId, title: 'Still owned' })).ownerId, f.member.userId);
	assert.equal((await c.updateSeries(f.actor, f.org, series.id, { expectedRevision: 1, ownerId: f.member.userId, title: 'Still owned' })).ownerId, f.member.userId);
	assert.equal((await c.updateProject(f.actor, f.org, project.id, { expectedRevision: 1, ownerId: f.member.userId, name: 'Still owned' })).ownerId, f.member.userId);
	const other = await c.createTask(f.actor, f.org, { title: 'Unowned' });
	await assert.rejects(c.updateTask(f.actor, f.org, other.id, { expectedRevision: 1, ownerId: f.member.userId }), { code: 'owner_invalid' });
});
