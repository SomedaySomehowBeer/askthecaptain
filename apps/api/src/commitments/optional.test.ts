import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { TagsService } from '../tags/service.ts';
import { SeriesRoutine } from './routine.ts';
import { CommitmentsService } from './service.ts';

// #133 step 4 (D7): a task or series may belong to no project. Nothing creates a project on the
// organisation's behalf, and standalone work is first-class in Work, tags and the series routine.
const it = databaseUrl ? test : test.skip;
let db: Harness;
/** The stored revision, for tests that are not about staleness: each edit is based on the current record. */
const rev = async (table: 'tasks' | 'projects' | 'task_series', id: string) => Number((await db.owner.unsafe(`select revision from ${table} where id = $1`, [id]))[0]!.revision);
before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

async function organisation(name = 'Optional projects') {
	const [o] = await db.owner`insert into organisations (name, timezone) values (${name}, 'Australia/Perth') returning id`;
	const [u] = await db.owner`insert into users (email) values (${randomUUID() + '@example.test'}) returning id`;
	const org = String(o!.id), actor = { userId: String(u!.id), requestId: randomUUID() };
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${actor.userId}, 'owner')`;
	const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: org, userId: actor.userId }, fn);
	return { org, actor, tx };
}
const projectCount = (org: string) => db.owner`select count(*)::int as n from projects where organisation_id = ${org}`.then(([r]) => r!.n as number);

it('a standalone task and its checklist stay out of any project, and follow the task into and out of one', async () => {
	const f = await organisation(); const c = new CommitmentsService(db.app);
	const task = await c.createTask(f.actor, f.org, { title: 'Service the chiller' });
	const step = await c.createTask(f.actor, f.org, { title: 'Order the filter', parentId: task.id, expectedParentRevision: await rev('tasks', task.id) });
	assert.deepEqual([task.projectId, step.projectId], [null, null]);
	assert.equal(await projectCount(f.org), 0, 'no project is created or implied');
	const [created] = await db.owner`select detail from audit_events where subject_id = ${task.id} and action = 'task.created'`;
	assert.equal((created!.detail as { projectId: unknown }).projectId, null);

	const plant = await c.createProject(f.actor, f.org, { name: 'Plant' });
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: await rev('tasks', task.id), projectId: plant.id })).projectId, plant.id);
	assert.deepEqual((await f.tx(sql => sql`select project_id from tasks where parent_id = ${task.id}`)).map(r => r.projectId), [plant.id], 'steps follow into the project');
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: await rev('tasks', task.id), title: 'Service the glycol chiller' })).projectId, plant.id, 'an absent projectId keeps the project');
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: await rev('tasks', task.id), projectId: null })).projectId, null);
	assert.deepEqual((await f.tx(sql => sql`select project_id from tasks where parent_id = ${task.id}`)).map(r => r.projectId), [null], 'and out of it');

	await assert.rejects(c.updateTask(f.actor, f.org, step.id, { expectedRevision: await rev('tasks', step.id), projectId: plant.id }), { code: 'step_project' });
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Elsewhere', parentId: task.id, expectedParentRevision: await rev('tasks', task.id), projectId: plant.id }), { code: 'step_project' });
	// The database refuses a mismatched step whichever side is null, not only the service.
	await assert.rejects(f.tx(sql => sql`update tasks set project_id = ${plant.id} where id = ${step.id}`), /belongs to its task's project/);
	await assert.rejects(f.tx(sql => sql`insert into tasks (organisation_id, project_id, parent_id, title) values (${f.org}, ${plant.id}, ${task.id}, 'raw')`), /belongs to its task's project/);
	const inPlant = await c.createTask(f.actor, f.org, { title: 'Descale', projectId: plant.id });
	await assert.rejects(f.tx(sql => sql`insert into tasks (organisation_id, project_id, parent_id, title) values (${f.org}, null, ${inPlant.id}, 'raw')`), /belongs to its task's project/);

	// Completing and cancelling still cascade to steps without a project.
	await c.updateTask(f.actor, f.org, task.id, { expectedRevision: await rev('tasks', task.id), status: 'done' });
	assert.equal((await f.tx(sql => sql`select status from tasks where id = ${step.id}`))[0]!.status, 'done');
});

it('a task can leave an archived project but cannot join one, and another tenant\'s project is invalid', async () => {
	const f = await organisation(); const other = await organisation('Other tenant'); const c = new CommitmentsService(db.app);
	const old = await c.createProject(f.actor, f.org, { name: 'Last season' });
	const task = await c.createTask(f.actor, f.org, { title: 'Return the kegs', projectId: old.id });
	await c.updateProject(f.actor, f.org, old.id, { expectedRevision: await rev('projects', old.id), archived: true });
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Late', projectId: old.id }), { code: 'project_invalid' });
	assert.equal((await c.updateTask(f.actor, f.org, task.id, { expectedRevision: await rev('tasks', task.id), projectId: null })).projectId, null);
	await assert.rejects(c.updateTask(f.actor, f.org, task.id, { expectedRevision: await rev('tasks', task.id), projectId: old.id }), { code: 'project_invalid' });
	const theirs = await c.createProject(other.actor, other.org, { name: 'Theirs' });
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Cross', projectId: theirs.id }), { code: 'project_invalid' });
	await assert.rejects(c.createSeries(f.actor, f.org, { title: 'Cross', projectId: theirs.id, recurrence: 'monthly', anchor: '2026-01-01' }), { code: 'project_invalid' });
});

it('series without a project materialise standalone occurrences; moving a series changes future occurrences only', async () => {
	const f = await organisation(); const c = new CommitmentsService(db.app);
	const loose = await c.createSeries(f.actor, f.org, { title: 'Clean the lines', recurrence: 'monthly', anchor: '2026-01-01' });
	assert.equal(loose.projectId, null);
	const occurrences = (id: string) => f.tx(sql => sql`select project_id, period_start::text from tasks where series_id = ${id} order by period_start`);
	assert.deepEqual((await occurrences(loose.id)).map(r => r.projectId), [null], 'the current occurrence is standalone');
	assert.equal(await projectCount(f.org), 0);

	const compliance = await c.createProject(f.actor, f.org, { name: 'Compliance' });
	const excise = await c.createSeries(f.actor, f.org, { title: 'Excise return', projectId: compliance.id, recurrence: 'monthly', anchor: '2026-01-01' });
	assert.deepEqual((await occurrences(excise.id)).map(r => r.projectId), [compliance.id]);
	assert.equal((await c.updateSeries(f.actor, f.org, excise.id, { expectedRevision: await rev('task_series', excise.id), title: 'Excise duty return' })).projectId, compliance.id, 'an absent projectId keeps the project');
	assert.equal((await c.updateSeries(f.actor, f.org, excise.id, { expectedRevision: await rev('task_series', excise.id), projectId: null })).projectId, null);
	await c.materialise(f.org, '2099-03-15');
	assert.deepEqual((await occurrences(excise.id)).map(r => [r.projectId, r.periodStart]).slice(-1), [[null, '2099-03-01']], 'the next occurrence is standalone');
	assert.equal((await occurrences(excise.id))[0]!.projectId, compliance.id, 'the existing occurrence keeps its project');
	assert.equal((await occurrences(loose.id)).length, 2, 'the standalone series produced its next period too');
});

it('the routine skips series in archived projects, never standalone ones, and discovers tenants with either', async () => {
	const c = new CommitmentsService(db.app); const routine = new SeriesRoutine(db.app, c);
	const standaloneOnly = await organisation('Standalone only'); const archivedOnly = await organisation('Archived only');
	await c.createSeries(standaloneOnly.actor, standaloneOnly.org, { title: 'Check the CO2', recurrence: 'monthly', anchor: '2026-01-01' });
	const shelved = await c.createProject(archivedOnly.actor, archivedOnly.org, { name: 'Shelved' });
	const inShelved = await c.createSeries(archivedOnly.actor, archivedOnly.org, { title: 'Shelved check', projectId: shelved.id, recurrence: 'monthly', anchor: '2026-01-01' });
	await c.updateProject(archivedOnly.actor, archivedOnly.org, shelved.id, { expectedRevision: await rev('projects', shelved.id), archived: true });
	const discovered = await routine.organisations();
	assert.ok(discovered.includes(standaloneOnly.org), 'a standalone series is active');
	assert.ok(!discovered.includes(archivedOnly.org), 'a series in an archived project is not');
	assert.equal(await routine.run(archivedOnly.org, '2099-03-15'), 0);
	assert.equal((await archivedOnly.tx(sql => sql`select count(*)::int as n from tasks where series_id = ${inShelved.id}`))[0]!.n, 1, 'only the occurrence made before archiving');
	assert.equal(await routine.run(standaloneOnly.org, '2099-03-15'), 1);
	assert.equal(await routine.run(standaloneOnly.org, '2099-03-15'), 0, 'idempotent');
});

it('Work and tags treat standalone tasks as eligible, and still exclude archived-project tasks and steps', async () => {
	const f = await organisation(); const c = new CommitmentsService(db.app); const tags = new TagsService(db.app);
	const loose = await c.createTask(f.actor, f.org, { title: 'Sweep the cold room', due: '2030-01-02' });
	await c.createTask(f.actor, f.org, { title: 'A step', parentId: loose.id, expectedParentRevision: await rev('tasks', loose.id) });
	const active = await c.createProject(f.actor, f.org, { name: 'Active' });
	const inActive = await c.createTask(f.actor, f.org, { title: 'Brew', projectId: active.id, due: '2030-01-01' });
	const archived = await c.createProject(f.actor, f.org, { name: 'Archived' });
	const inArchived = await c.createTask(f.actor, f.org, { title: 'Hidden', projectId: archived.id });
	await c.updateProject(f.actor, f.org, archived.id, { expectedRevision: await rev('projects', archived.id), archived: true });

	const work = await tags.work(f.actor, f.org, {});
	assert.deepEqual(work.tasks.map(t => [t.title, t.projectId]), [['Brew', active.id], ['Sweep the cold room', null]]);
	assert.deepEqual((await tags.work(f.actor, f.org, { projectId: active.id })).tasks.map(t => t.id), [inActive.id]);

	const tag = await tags.save(f.actor, f.org, { name: 'Cellar' });
	await tags.setLink(f.actor, f.org, loose.id, tag.id, true);
	assert.deepEqual((await tags.work(f.actor, f.org, { tagIds: [tag.id] })).tasks.map(t => [t.id, t.tags.map(x => x.name)]), [[loose.id, ['Cellar']]]);
	assert.equal((await tags.options(f.actor, f.org, loose.id, 0, 10)).task.id, loose.id);
	await assert.rejects(tags.setLink(f.actor, f.org, inArchived.id, tag.id, true), { status: 404 });
	await assert.rejects(tags.options(f.actor, f.org, inArchived.id, 0, 10), { status: 404 });
});
