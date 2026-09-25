import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

/** Cross-tenant tests for the commitments tables (D6): projects, task_series, tasks, evidence. */
const it = databaseUrl ? test : test.skip;
let db: Harness;
const ids = { orgA: '', orgB: '', alice: '', bob: '', projectA: '', projectB: '', seriesB: '', taskA: '', taskB: '', evidenceB: '' };

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const [a] = await db.owner`insert into organisations (name) values ('A') returning id`;
	const [b] = await db.owner`insert into organisations (name) values ('B') returning id`;
	const [alice] = await db.owner`insert into users (email, name) values ('alice@example.com', 'Alice') returning id`;
	const [bob] = await db.owner`insert into users (email, name) values ('bob@example.com', 'Bob') returning id`;
	Object.assign(ids, { orgA: a!.id, orgB: b!.id, alice: alice!.id, bob: bob!.id });
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${ids.orgA}, ${ids.alice}, 'owner'), (${ids.orgB}, ${ids.bob}, 'owner')`;
	const [pa] = await db.owner`insert into projects (organisation_id, name) values (${ids.orgA}, 'Compliance') returning id`;
	const [pb] = await db.owner`insert into projects (organisation_id, name) values (${ids.orgB}, 'Compliance') returning id`;
	Object.assign(ids, { projectA: pa!.id, projectB: pb!.id });
	const [sb] = await db.owner`insert into task_series (organisation_id, project_id, title, recurrence, anchor) values (${ids.orgB}, ${ids.projectB}, 'Excise', 'monthly', '2026-01-01') returning id`;
	const [ta] = await db.owner`insert into tasks (organisation_id, project_id, title) values (${ids.orgA}, ${ids.projectA}, 'A task') returning id`;
	const [tb] = await db.owner`insert into tasks (organisation_id, project_id, title, series_id, period_start, period_end) values (${ids.orgB}, ${ids.projectB}, 'B task', ${sb!.id}, '2026-09-01', '2026-09-30') returning id`;
	const [eb] = await db.owner`insert into evidence (organisation_id, task_id, kind, reference) values (${ids.orgB}, ${tb!.id}, 'url', 'https://example.test') returning id`;
	Object.assign(ids, { seriesB: sb!.id, taskA: ta!.id, taskB: tb!.id, evidenceB: eb!.id });
});
after(async () => { await db?.close(); });

const asA = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant<T>(db.app, { organisationId: ids.orgA, userId: ids.alice }, work);

it('without a tenant context the runtime role sees no commitments', async () => {
	for (const table of ['projects', 'task_series', 'tasks', 'evidence']) assert.equal((await db.app.unsafe(`select id from ${table}`)).length, 0, table);
});

it('a tenant sees only its own projects, series, tasks and evidence', async () => {
	const seen = await asA(async (tx) => ({
		projects: (await tx`select id from projects`).map((r) => r.id), series: (await tx`select id from task_series`).map((r) => r.id),
		tasks: (await tx`select id from tasks`).map((r) => r.id), evidence: (await tx`select id from evidence`).map((r) => r.id)
	}));
	assert.deepEqual(seen, { projects: [ids.projectA], series: [], tasks: [ids.taskA], evidence: [] });
});

it('a tenant cannot write into another tenant, directly or by referencing its rows', async () => {
	await assert.rejects(asA((tx) => tx`insert into tasks (organisation_id, project_id, title) values (${ids.orgB}, ${ids.projectB}, 'stolen')`), /row-level security/);
	await assert.rejects(asA((tx) => tx`insert into projects (organisation_id, name) values (${ids.orgB}, 'stolen')`), /row-level security/);
	await assert.rejects(asA((tx) => tx`insert into evidence (organisation_id, task_id, kind, reference) values (${ids.orgB}, ${ids.taskB}, 'url', 'https://x')`), /row-level security/);
	// Foreign key checks bypass row security, so every child key carries organisation_id: a row in
	// the right tenant that points at the other tenant's project or series does not match.
	await assert.rejects(asA((tx) => tx`insert into tasks (organisation_id, project_id, title) values (${ids.orgA}, ${ids.projectB}, 'cross')`), /violates foreign key/);
	await assert.rejects(asA((tx) => tx`insert into tasks (organisation_id, project_id, title, series_id, period_start, period_end) values (${ids.orgA}, ${ids.projectA}, 'cross', ${ids.seriesB}, '2026-10-01', '2026-10-31')`), /violates foreign key/);
	await assert.rejects(asA((tx) => tx`insert into evidence (organisation_id, task_id, kind, reference) values (${ids.orgA}, ${ids.taskB}, 'url', 'https://x')`), /violates foreign key/);
	assert.equal((await asA((tx) => tx`update tasks set title = 'x' where id = ${ids.taskB} returning id`)).length, 0);
	assert.equal((await asA((tx) => tx`delete from evidence where id = ${ids.evidenceB} returning id`)).length, 0);
	assert.equal((await asA((tx) => tx`update task_series set title = 'x' where id = ${ids.seriesB} returning id`)).length, 0);
	assert.equal((await db.owner`select title from tasks where id = ${ids.taskB}`)[0]!.title, 'B task');
});

it('one occurrence per series period, and an occurrence carries its period', async () => {
	await assert.rejects(db.owner`insert into tasks (organisation_id, project_id, title, series_id, period_start, period_end) values (${ids.orgB}, ${ids.projectB}, 'dup', ${ids.seriesB}, '2026-09-01', '2026-09-30')`, /tasks_one_per_series_period/);
	await assert.rejects(db.owner`insert into tasks (organisation_id, project_id, title, series_id) values (${ids.orgB}, ${ids.projectB}, 'no period', ${ids.seriesB})`, /check constraint/);
});

// #133 step 4 (migration 0038): a task or series may have no project; tenant keys still bind when one is named.
it('a tenant may create standalone tasks, steps and series, and a named project must still be its own', async () => {
	const [series] = await asA((tx) => tx`insert into task_series (organisation_id, title, recurrence, anchor) values (${ids.orgA}, 'Standalone', 'monthly', '2026-01-01') returning id, project_id`);
	assert.equal(series!.projectId, null);
	const [task] = await asA((tx) => tx`insert into tasks (organisation_id, title) values (${ids.orgA}, 'Standalone') returning id, project_id`);
	assert.equal(task!.projectId, null);
	const [step] = await asA((tx) => tx`insert into tasks (organisation_id, parent_id, title) values (${ids.orgA}, ${task!.id}, 'Step') returning project_id`);
	assert.equal(step!.projectId, null);
	await assert.rejects(asA((tx) => tx`insert into tasks (organisation_id, project_id, parent_id, title) values (${ids.orgA}, ${ids.projectA}, ${task!.id}, 'Mismatched')`), /belongs to its task's project/);
	await assert.rejects(asA((tx) => tx`update tasks set project_id = ${ids.projectB} where id = ${task!.id}`), /violates foreign key/);
	await assert.rejects(asA((tx) => tx`insert into task_series (organisation_id, project_id, title, recurrence, anchor) values (${ids.orgA}, ${ids.projectB}, 'cross', 'monthly', '2026-01-01')`), /violates foreign key/);
	// Tenant B still sees none of it.
	const seenByB = await withTenant(db.app, { organisationId: ids.orgB, userId: ids.bob }, (tx) => tx`select id from tasks where project_id is null`);
	assert.equal(seenByB.length, 0);
});

it('the series routine discovers a tenant whose only active series has no project, not one whose project is archived', async () => {
	const [c] = await db.owner`insert into organisations (name) values ('C') returning id`;
	const [archived] = await db.owner`insert into projects (organisation_id, name, archived_at) values (${c!.id}, 'Shelved', now()) returning id`;
	await db.owner`insert into task_series (organisation_id, project_id, title, recurrence, anchor) values (${c!.id}, ${archived!.id}, 'Shelved', 'monthly', '2026-01-01')`;
	const discovered = async () => (await db.app`select organisation_id from series_organisations()`).map((r) => r.organisationId as string);
	assert.ok(!(await discovered()).includes(c!.id));
	await db.owner`insert into task_series (organisation_id, title, recurrence, anchor, paused_at) values (${c!.id}, 'Paused', 'monthly', '2026-01-01', now())`;
	assert.ok(!(await discovered()).includes(c!.id), 'a paused standalone series is not active');
	await db.owner`insert into task_series (organisation_id, title, recurrence, anchor) values (${c!.id}, 'Loose', 'monthly', '2026-01-01')`;
	assert.ok((await discovered()).includes(c!.id));
});

it('an equipment reservation may link a standalone task without a project', async () => {
	const [equipment] = await db.owner`insert into equipment (organisation_id, name) values (${ids.orgA}, 'Fermenter') returning id`;
	const [task] = await db.owner`insert into tasks (organisation_id, title) values (${ids.orgA}, 'Standalone booking task') returning id`;
	const [reservation] = await db.owner`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, task_id, created_by)
		values (gen_random_uuid(), ${ids.orgA}, ${equipment!.id}, 'Clean', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', ${task!.id}, ${ids.alice}) returning project_id, task_id`;
	assert.deepEqual([reservation!.projectId, reservation!.taskId], [null, task!.id]);
	const [left] = await db.owner`select count(*)::int as n from pg_constraint where conrelid = 'equipment_reservations'::regclass and pg_get_constraintdef(oid) like '%task_id IS NULL%project_id IS NOT NULL%'`;
	assert.equal(left!.n, 0, 'migration 0038 removed the task-requires-project check');
});
