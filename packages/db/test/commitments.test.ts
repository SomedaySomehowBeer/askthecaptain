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
	const [pa] = await db.owner`insert into projects (organisation_id, name, system_kind) values (${ids.orgA}, 'Obligations', 'obligations') returning id`;
	const [pb] = await db.owner`insert into projects (organisation_id, name, system_kind) values (${ids.orgB}, 'Obligations', 'obligations') returning id`;
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

it('one Obligations project per organisation and one occurrence per series period', async () => {
	await assert.rejects(db.owner`insert into projects (organisation_id, name, system_kind) values (${ids.orgA}, 'Again', 'obligations')`, /projects_one_system_per_kind/);
	await assert.rejects(db.owner`insert into tasks (organisation_id, project_id, title, series_id, period_start, period_end) values (${ids.orgB}, ${ids.projectB}, 'dup', ${ids.seriesB}, '2026-09-01', '2026-09-30')`, /tasks_one_per_series_period/);
	await assert.rejects(db.owner`insert into tasks (organisation_id, project_id, title, series_id) values (${ids.orgB}, ${ids.projectB}, 'no period', ${ids.seriesB})`, /check constraint/);
});
