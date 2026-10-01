import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { TagsService } from '../tags/service.ts';
import { SeriesRoutine } from './routine.ts';
import { CommitmentsService } from './service.ts';

// Work without projects (D7 amended; threads contract §1, §3): since 0046 no task, step or series has a project. A task's
// tags are its thread's, a series' tags are given to each occurrence's thread, and a tag never stops or hides work.
const it = databaseUrl ? test : test.skip;
let db: Harness;
/** The stored revision, for tests that are not about staleness: each edit is based on the current record. */
const rev = async (table: 'tasks' | 'tags' | 'task_series', id: string) => Number((await db.owner.unsafe(`select revision from ${table} where id = $1`, [id]))[0]!.revision);
before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

async function organisation(name = 'Work without projects') {
	const [o] = await db.owner`insert into organisations (name, timezone) values (${name}, 'Australia/Perth') returning id`;
	const [u] = await db.owner`insert into users (email) values (${randomUUID() + '@example.test'}) returning id`;
	const org = String(o!.id), actor = { userId: String(u!.id), requestId: randomUUID() };
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${actor.userId}, 'owner')`;
	const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: org, userId: actor.userId }, fn);
	return { org, actor, tx };
}
const tagsOn = (taskId: string) => db.owner<{ tagId: string }[]>`select tt.tag_id from threads th join thread_tags tt on tt.thread_id = th.id where th.task_id = ${taskId} order by tt.tag_id`
	.then((rows) => rows.map((r) => r.tagId));

it('a task and its checklist carry no project; the task has a thread and its steps share it', async () => {
	const f = await organisation(); const c = new CommitmentsService(db.app);
	const task = await c.createTask(f.actor, f.org, { title: 'Service the chiller' });
	const step = await c.createTask(f.actor, f.org, { title: 'Order the filter', parentId: task.id, expectedParentRevision: await rev('tasks', task.id) });
	assert.ok(!('projectId' in task) && !('projectId' in step));
	const [created] = await db.owner`select detail from audit_events where subject_id = ${task.id} and action = 'task.created'`;
	assert.ok(!('projectId' in (created!.detail as object)));
	assert.deepEqual((await db.owner`select task_id from threads where task_id in ${db.owner([task.id, step.id])}`).map((r) => r.taskId), [task.id]);
	await assert.rejects(c.createTask(f.actor, f.org, { title: 'Too deep', parentId: step.id, expectedParentRevision: await rev('tasks', step.id) }), { code: 'step_depth' });
	// Completing and cancelling still cascade to steps.
	await c.updateTask(f.actor, f.org, task.id, { expectedRevision: await rev('tasks', task.id), status: 'done' });
	assert.equal((await f.tx(sql => sql`select status from tasks where id = ${step.id}`))[0]!.status, 'done');
});

it('a series gives its tags to each new occurrence; untagged series make untagged occurrences; edits change future ones only', async () => {
	const f = await organisation(); const c = new CommitmentsService(db.app); const tags = new TagsService(db.app);
	const loose = await c.createSeries(f.actor, f.org, { title: 'Clean the lines', recurrence: 'monthly', anchor: '2026-01-01' });
	assert.deepEqual(loose.tagIds, []);
	const occurrences = (id: string) => f.tx(sql => sql<{ id: string; periodStart: string }[]>`select id, period_start::text from tasks where series_id = ${id} order by period_start`);
	assert.deepEqual(await tagsOn((await occurrences(loose.id))[0]!.id), []);
	const compliance = await tags.create(f.actor, f.org, { name: 'Compliance' });
	const excise = await c.createSeries(f.actor, f.org, { title: 'Excise return', tagIds: [compliance.id], recurrence: 'monthly', anchor: '2026-01-01' });
	assert.deepEqual(await tagsOn((await occurrences(excise.id))[0]!.id), [compliance.id]);
	assert.deepEqual((await c.updateSeries(f.actor, f.org, excise.id, { expectedRevision: await rev('task_series', excise.id), title: 'Excise duty return' })).tagIds, [compliance.id],
		'an absent tagIds keeps the tags');
	assert.deepEqual((await c.updateSeries(f.actor, f.org, excise.id, { expectedRevision: await rev('task_series', excise.id), tagIds: [] })).tagIds, []);
	await c.materialise(f.org, '2099-03-15');
	const all = await occurrences(excise.id);
	assert.deepEqual([all.at(-1)!.periodStart, await tagsOn(all.at(-1)!.id)], ['2099-03-01', []], 'the next occurrence has the new (empty) set');
	assert.deepEqual(await tagsOn(all[0]!.id), [compliance.id], 'the existing occurrence keeps its thread’s tags');
	assert.equal((await occurrences(loose.id)).length, 2, 'the untagged series produced its next period too');
	await assert.rejects(c.createSeries(f.actor, f.org, { title: 'Cross', tagIds: [randomUUID()], recurrence: 'monthly', anchor: '2026-01-01' }), { status: 404 });
});

it('the routine discovers every tenant with an unpaused series; an archived tag never stops one', async () => {
	const c = new CommitmentsService(db.app); const routine = new SeriesRoutine(db.app, c); const tags = new TagsService(db.app);
	const f = await organisation('Archived tag');
	const shelved = await tags.create(f.actor, f.org, { name: 'Shelved' });
	const inShelved = await c.createSeries(f.actor, f.org, { title: 'Shelved check', tagIds: [shelved.id], recurrence: 'monthly', anchor: '2026-01-01' });
	await tags.update(f.actor, f.org, shelved.id, { expectedRevision: await rev('tags', shelved.id), archived: true });
	assert.ok((await routine.organisations()).includes(f.org));
	assert.equal(await routine.run(f.org, '2099-03-15'), 1);
	assert.equal(await routine.run(f.org, '2099-03-15'), 0, 'idempotent');
	const latest = (await f.tx(sql => sql<{ id: string }[]>`select id from tasks where series_id = ${inShelved.id} order by period_start desc limit 1`))[0]!.id;
	assert.deepEqual(await tagsOn(latest), [shelved.id], 'archiving keeps a tag on new work too: it is still the series’ tag');
});

it('Work lists top-level tasks, untagged or tagged, never steps', async () => {
	const f = await organisation(); const c = new CommitmentsService(db.app); const tags = new TagsService(db.app);
	const loose = await c.createTask(f.actor, f.org, { title: 'Sweep the cold room', due: '2030-01-02' });
	await c.createTask(f.actor, f.org, { title: 'A step', parentId: loose.id, expectedParentRevision: await rev('tasks', loose.id) });
	const brew = await c.createTask(f.actor, f.org, { title: 'Brew', due: '2030-01-01' });
	const work = await tags.work(f.actor, f.org, {});
	assert.deepEqual(work.tasks.map(t => t.title), ['Brew', 'Sweep the cold room']);
	const tag = await tags.create(f.actor, f.org, { name: 'Cellar' });
	await f.tx(sql => sql`insert into thread_tags (organisation_id, thread_id, tag_id, attached_by) select organisation_id, id, ${tag.id}, ${f.actor.userId} from threads where task_id = ${brew.id}`);
	assert.deepEqual((await tags.work(f.actor, f.org, { tagIds: [tag.id] })).tasks.map(t => [t.id, t.tags.map(x => x.name)]), [[brew.id, ['Cellar']]]);
	assert.equal((await tags.options(f.actor, f.org, loose.id, 0, 10)).task.id, loose.id);
});
