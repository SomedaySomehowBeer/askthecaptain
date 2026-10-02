import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { CommitmentsService } from './service.ts';
import { workflowFixture } from '../../test/workflow-fixture.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
/** The stored revision, for tests that are not about staleness: each edit is based on the current record. */
const rev = async (table: 'tasks' | 'task_series', id: string) => Number((await db.owner.unsafe(`select revision from ${table} where id = $1`, [id]))[0]!.revision);
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });

// The project brief, stage and state tests retired with projects (0046): a project is a tag, with no brief or stage.
it("steps are a task's checklist: one level deep, part of its thread, and they follow it when it is accepted, completed or cancelled", async () => {
	const f = await workflowFixture(db); try {
		const c = new CommitmentsService(db.app);
		const art = await c.createTask(f.actor, f.org, { title: 'Send final artwork' });
		const step1 = await c.createTask(f.actor, f.org, { title: 'Export PDF', parentId: art.id, expectedParentRevision: await rev('tasks', art.id) });
		const step2 = await c.createTask(f.actor, f.org, { title: 'Email CanCo', parentId: art.id, expectedParentRevision: await rev('tasks', art.id) });
		assert.equal(step1.parentId, art.id); assert.equal(step2.parentId, art.id);
		assert.equal((await f.tx(sql => sql`select 1 from threads where task_id in ${sql([step1.id, step2.id])}`)).length, 0, 'a step has no thread of its own');
		await assert.rejects(c.createTask(f.actor, f.org, { title: 'Too deep', parentId: step1.id, expectedParentRevision: await rev('tasks', step1.id) }), { code: 'step_depth' });
		await assert.rejects(f.write(sql => sql`update tasks set parent_id = ${step1.id} where id = ${art.id}`), /step/, 'the trigger refuses a second level either way round');
		await assert.rejects(f.write(sql => sql`update tasks set series_id = gen_random_uuid(), period_start = current_date, period_end = current_date where id = ${step1.id}`), /tasks_step_has_no_series|violates/);
		// The morning brief's snapshot lists tasks, not their steps; accepting a suggested task accepts its steps.
		const book = await c.createTask(f.actor, f.org, { title: 'Book the line', status: 'suggested' });
		const call = await c.createTask(f.actor, f.org, { title: 'Call Sam', parentId: book.id, expectedParentRevision: await rev('tasks', book.id), status: 'suggested' });
		assert.deepEqual((await f.tx(sql => c.briefTasks(sql, f.org))).tasks.map(t => t.title), ['Book the line']);
		await c.updateTask(f.actor, f.org, book.id, { expectedRevision: await rev('tasks', book.id), status: 'open' });
		assert.equal((await f.tx(sql => sql`select status from tasks where id = ${call.id}`))[0]!.status, 'open');
		// Completing the task completes its open steps as the person; cancelling cancels them.
		await c.updateTask(f.actor, f.org, step1.id, { expectedRevision: await rev('tasks', step1.id), status: 'done' });
		await c.updateTask(f.actor, f.org, art.id, { expectedRevision: await rev('tasks', art.id), status: 'done' });
		const after = await f.tx(sql => sql`select status, completed_by from tasks where parent_id = ${art.id} order by created_at`);
		assert.deepEqual(after.map(r => [r.status, r.completedBy]), [['done', f.actor.userId], ['done', f.actor.userId]]);
		await c.updateTask(f.actor, f.org, book.id, { expectedRevision: await rev('tasks', book.id), status: 'cancelled' });
		assert.equal((await f.tx(sql => sql`select status from tasks where id = ${call.id}`))[0]!.status, 'cancelled');
		const overview = await c.overview(f.actor, f.org);
		assert.deepEqual(overview.tasks.filter(t => t.parentId === art.id).map(t => t.title).sort(), ['Email CanCo', 'Export PDF']);
	} finally { await f.engine.close(); }
});
