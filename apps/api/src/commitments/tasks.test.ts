import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { CommitmentsService } from './service.ts';
import { NotesService } from '../notes/service.ts';
import { triageFixture } from '../../test/triage-fixture.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });

it("steps are a task's checklist: one level deep, in its project, and they follow it when it moves, is accepted, completed or cancelled", async () => {
	const f = await triageFixture(db); try {
		const c = new CommitmentsService(db.app);
		const cans = await c.createProject(f.actor, f.org, { name: 'Cans for October' }); const other = await c.createProject(f.actor, f.org, { name: 'Other' });
		const art = await c.createTask(f.actor, f.org, { title: 'Send final artwork', projectId: cans.id });
		const step1 = await c.createTask(f.actor, f.org, { title: 'Export PDF', parentId: art.id });
		const step2 = await c.createTask(f.actor, f.org, { title: 'Email CanCo', parentId: art.id, projectId: other.id });
		assert.equal(step1.parentId, art.id); assert.equal(step2.projectId, cans.id, 'a step is in its parent project whatever was asked');
		await assert.rejects(c.createTask(f.actor, f.org, { title: 'Too deep', parentId: step1.id }), { code: 'step_depth' });
		await assert.rejects(c.updateTask(f.actor, f.org, step1.id, { projectId: other.id }), { code: 'step_project' });
		await assert.rejects(f.tx(sql => sql`update tasks set parent_id = ${step1.id} where id = ${art.id}`), /step/, 'the trigger refuses a second level either way round');
		await assert.rejects(f.tx(sql => sql`update tasks set series_id = gen_random_uuid(), period_start = current_date, period_end = current_date where id = ${step1.id}`), /tasks_step_has_no_series|violates/);
		// Moving the task moves its steps.
		await c.updateTask(f.actor, f.org, art.id, { projectId: other.id });
		assert.deepEqual((await f.tx(sql => sql`select distinct project_id from tasks where parent_id = ${art.id}`)).map(r => r.projectId), [other.id]);
		// The morning brief's snapshot lists tasks, not their steps; accepting a suggested task accepts its steps.
		const book = await c.createTask(f.actor, f.org, { title: 'Book the line', projectId: cans.id, status: 'suggested' });
		const call = await c.createTask(f.actor, f.org, { title: 'Call Sam', parentId: book.id, status: 'suggested' });
		assert.deepEqual((await f.tx(sql => c.briefTasks(sql, f.org))).tasks.map(t => t.title), ['Book the line']);
		await c.updateTask(f.actor, f.org, book.id, { status: 'open' });
		assert.equal((await f.tx(sql => sql`select status from tasks where id = ${call.id}`))[0]!.status, 'open');
		// Completing the task completes its open steps as the person; cancelling cancels them.
		await c.updateTask(f.actor, f.org, step1.id, { status: 'done' });
		await c.updateTask(f.actor, f.org, art.id, { status: 'done' });
		const after = await f.tx(sql => sql`select status, completed_by from tasks where parent_id = ${art.id} order by created_at`);
		assert.deepEqual(after.map(r => [r.status, r.completedBy]), [['done', f.actor.userId], ['done', f.actor.userId]]);
		await c.updateTask(f.actor, f.org, book.id, { status: 'cancelled' });
		assert.equal((await f.tx(sql => sql`select status from tasks where id = ${call.id}`))[0]!.status, 'cancelled');
		const overview = await c.overview(f.actor, f.org);
		assert.deepEqual(overview.tasks.filter(t => t.parentId === art.id).map(t => t.title).sort(), ['Email CanCo', 'Export PDF']);
	} finally { await f.engine.close(); }
});

it('the brief and stage are saved by a person; a line may cite only a thread or note that exists here', async () => {
	const f = await triageFixture(db); try {
		const c = new CommitmentsService(db.app); const notes = new NotesService(db.app, null);
		const taproom = await c.createProject(f.actor, f.org, { name: 'City taproom' });
		assert.equal(taproom.stage, 'underway'); assert.deepEqual(taproom.brief, { what: [], standing: [], people: [], questions: [] });
		const note = await notes.create(f.actor, f.org, { title: 'Site visit', body: 'The George St site has a bar licence already.', projectId: taproom.id });
		const brief = { what: [{ text: 'A second taproom in the city.', evidence: null }], standing: [{ text: 'Two sites seen.', evidence: { kind: 'note' as const, id: note.id } }], people: [], questions: [{ text: 'Which site?', evidence: null }] };
		const saved = await c.updateProject(f.actor, f.org, taproom.id, { stage: 'idea', brief });
		assert.equal(saved.stage, 'idea'); assert.deepEqual(saved.brief, brief); assert.ok(saved.briefUpdatedAt instanceof Date);
		await assert.rejects(c.updateProject(f.actor, f.org, taproom.id, { brief: { ...brief, people: [{ text: 'Sam', evidence: { kind: 'mail_thread', id: note.id } }] } }), { code: 'evidence_unknown' });
		const [event] = await f.tx(sql => sql`select action, detail from audit_events where subject_id = ${taproom.id} and action = 'project.brief_updated'`);
		assert.deepEqual(event!.detail, { stage: 'idea', lines: { what: 1, standing: 1, people: 0, questions: 1 } });
		assert.equal((await c.overview(f.actor, f.org)).projects.find(p => p.id === taproom.id)!.stage, 'idea');
	} finally { await f.engine.close(); }
});

it('project responses expose the database state used by Work filters and Commitments sections', async () => {
 const f = await triageFixture(db); try {
  const c = new CommitmentsService(db.app);
  const project = await c.createProject(f.actor, f.org, { name: 'Visible launch' });
  assert.equal(project.state, 'active');
  assert.equal((await c.overview(f.actor, f.org)).projects.find(p => p.id === project.id)!.state, 'active');
  assert.equal((await c.updateProject(f.actor, f.org, project.id, { archived: true })).state, 'archived');
  assert.equal((await c.overview(f.actor, f.org)).projects.find(p => p.id === project.id)!.state, 'archived');
  await c.updateProject(f.actor, f.org, project.id, { archived: false });
  await f.tx(tx => tx`update projects set proposed_at = now(), accepted_at = null where id = ${project.id}`);
  assert.equal((await c.overview(f.actor, f.org)).projects.find(p => p.id === project.id)!.state, 'proposed');
 } finally { await f.engine.close(); }
});
