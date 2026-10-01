import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

/** Cross-tenant tests for the commitments tables (D6): task_series, tasks, evidence, and since 0046 the series' tags. */
const it = databaseUrl ? test : test.skip;
let db: Harness;
const ids = { orgA: '', orgB: '', alice: '', bob: '', tagA: '', tagB: '', seriesB: '', taskA: '', taskB: '', evidenceB: '' };

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const [a] = await db.owner`insert into organisations (name) values ('A') returning id`;
	const [b] = await db.owner`insert into organisations (name) values ('B') returning id`;
	const [alice] = await db.owner`insert into users (email, name) values ('alice@example.com', 'Alice') returning id`;
	const [bob] = await db.owner`insert into users (email, name) values ('bob@example.com', 'Bob') returning id`;
	Object.assign(ids, { orgA: a!.id, orgB: b!.id, alice: alice!.id, bob: bob!.id });
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${ids.orgA}, ${ids.alice}, 'owner'), (${ids.orgB}, ${ids.bob}, 'owner')`;
	const [ta2] = await db.owner`insert into tags (organisation_id, name) values (${ids.orgA}, 'Compliance') returning id`;
	const [tb2] = await db.owner`insert into tags (organisation_id, name) values (${ids.orgB}, 'Compliance') returning id`;
	Object.assign(ids, { tagA: ta2!.id, tagB: tb2!.id });
	const [sb] = await db.owner`insert into task_series (organisation_id, title, recurrence, anchor) values (${ids.orgB}, 'Excise', 'monthly', '2026-01-01') returning id`;
	await db.owner`insert into task_series_tags (organisation_id, series_id, tag_id) values (${ids.orgB}, ${sb!.id}, ${ids.tagB})`;
	const [ta] = await db.owner`insert into tasks (organisation_id, title) values (${ids.orgA}, 'A task') returning id`;
	const [tb] = await db.owner`insert into tasks (organisation_id, title, series_id, period_start, period_end) values (${ids.orgB}, 'B task', ${sb!.id}, '2026-09-01', '2026-09-30') returning id`;
	const [eb] = await db.owner`insert into evidence (organisation_id, task_id, kind, reference) values (${ids.orgB}, ${tb!.id}, 'url', 'https://example.test') returning id`;
	Object.assign(ids, { seriesB: sb!.id, taskA: ta!.id, taskB: tb!.id, evidenceB: eb!.id });
});
after(async () => { await db?.close(); });

const asA = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant<T>(db.app, { organisationId: ids.orgA, userId: ids.alice }, work);

it('without a tenant context the runtime role sees no commitments', async () => {
	for (const table of ['tags', 'task_series', 'task_series_tags', 'tasks', 'evidence']) assert.equal((await db.app.unsafe(`select 1 from ${table}`)).length, 0, table);
});

it('a tenant sees only its own tags, series, tasks and evidence', async () => {
	const seen = await asA(async (tx) => ({
		tags: (await tx`select id from tags`).map((r) => r.id), series: (await tx`select id from task_series`).map((r) => r.id),
		seriesTags: (await tx`select 1 from task_series_tags`).length,
		tasks: (await tx`select id from tasks`).map((r) => r.id), evidence: (await tx`select id from evidence`).map((r) => r.id)
	}));
	assert.deepEqual(seen, { tags: [ids.tagA], series: [], seriesTags: 0, tasks: [ids.taskA], evidence: [] });
});

it('a tenant cannot write into another tenant, directly or by referencing its rows', async () => {
	await assert.rejects(asA((tx) => tx`insert into tasks (organisation_id, title) values (${ids.orgB}, 'stolen')`), /row-level security/);
	await assert.rejects(asA((tx) => tx`insert into tags (organisation_id, name) values (${ids.orgB}, 'stolen')`), /row-level security/);
	await assert.rejects(asA((tx) => tx`insert into evidence (organisation_id, task_id, kind, reference) values (${ids.orgB}, ${ids.taskB}, 'url', 'https://x')`), /row-level security/);
	// Foreign key checks bypass row security, so every child key carries organisation_id: a row in
	// the right tenant that points at the other tenant's tag or series does not match.
	await assert.rejects(asA((tx) => tx`insert into tasks (organisation_id, title, series_id, period_start, period_end) values (${ids.orgA}, 'cross', ${ids.seriesB}, '2026-10-01', '2026-10-31')`), /violates foreign key/);
	await assert.rejects(asA((tx) => tx`insert into evidence (organisation_id, task_id, kind, reference) values (${ids.orgA}, ${ids.taskB}, 'url', 'https://x')`), /violates foreign key/);
	await assert.rejects(asA((tx) => tx`insert into task_series_tags (organisation_id, series_id, tag_id) values (${ids.orgA}, ${ids.seriesB}, ${ids.tagA})`), /violates foreign key/);
	assert.equal((await asA((tx) => tx`update tasks set title = 'x' where id = ${ids.taskB} returning id`)).length, 0);
	assert.equal((await asA((tx) => tx`delete from evidence where id = ${ids.evidenceB} returning id`)).length, 0);
	assert.equal((await asA((tx) => tx`update task_series set title = 'x' where id = ${ids.seriesB} returning id`)).length, 0);
	assert.equal((await asA((tx) => tx`delete from task_series_tags where series_id = ${ids.seriesB} returning 1`)).length, 0);
	assert.equal((await db.owner`select title from tasks where id = ${ids.taskB}`)[0]!.title, 'B task');
});

it('one occurrence per series period, and an occurrence carries its period', async () => {
	await assert.rejects(db.owner`insert into tasks (organisation_id, title, series_id, period_start, period_end) values (${ids.orgB}, 'dup', ${ids.seriesB}, '2026-09-01', '2026-09-30')`, /tasks_one_per_series_period/);
	await assert.rejects(db.owner`insert into tasks (organisation_id, title, series_id) values (${ids.orgB}, 'no period', ${ids.seriesB})`, /check constraint/);
});

// Since 0046 no task, step or series has a project: tags sit on the task's thread and on the series.
it('a tenant creates tasks, steps and series with no project column at all', async () => {
	const columns = await db.owner`select table_name from information_schema.columns where column_name = 'project_id' and table_schema = 'public'`;
	assert.deepEqual([...columns], []);
	const [series] = await asA((tx) => tx`insert into task_series (organisation_id, title, recurrence, anchor) values (${ids.orgA}, 'Standalone', 'monthly', '2026-01-01') returning id`);
	await asA((tx) => tx`insert into task_series_tags (organisation_id, series_id, tag_id) values (${ids.orgA}, ${series!.id}, ${ids.tagA})`);
	const [task] = await asA((tx) => tx`insert into tasks (organisation_id, title) values (${ids.orgA}, 'Standalone') returning id`);
	await asA((tx) => tx`insert into tasks (organisation_id, parent_id, title) values (${ids.orgA}, ${task!.id}, 'Step')`);
	// Tenant B still sees none of it.
	const seenByB = await withTenant(db.app, { organisationId: ids.orgB, userId: ids.bob }, (tx) => tx`select id from tasks where id = ${task!.id}`);
	assert.equal(seenByB.length, 0);
});

it('the series routine discovers a tenant with an active series, whatever its tags, and not one whose series are all paused', async () => {
	const [c] = await db.owner`insert into organisations (name) values ('C') returning id`;
	const discovered = async () => (await db.app`select organisation_id from series_organisations()`).map((r) => r.organisationId as string);
	await db.owner`insert into task_series (organisation_id, title, recurrence, anchor, paused_at) values (${c!.id}, 'Paused', 'monthly', '2026-01-01', now())`;
	assert.ok(!(await discovered()).includes(c!.id), 'a paused series is not active');
	const [archived] = await db.owner`insert into tags (organisation_id, name, archived_at) values (${c!.id}, 'Shelved', now()) returning id`;
	const [series] = await db.owner`insert into task_series (organisation_id, title, recurrence, anchor) values (${c!.id}, 'Tagged', 'monthly', '2026-01-01') returning id`;
	await db.owner`insert into task_series_tags (organisation_id, series_id, tag_id) values (${c!.id}, ${series!.id}, ${archived!.id})`;
	assert.ok((await discovered()).includes(c!.id), 'an archived tag never stops work');
});

it('an equipment reservation may link a standalone task', async () => {
	const [equipment] = await db.owner`insert into equipment (organisation_id, name) values (${ids.orgA}, 'Fermenter') returning id`;
	const [task] = await db.owner`insert into tasks (organisation_id, title) values (${ids.orgA}, 'Standalone booking task') returning id`;
	const [reservation] = await db.owner`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, task_id, created_by)
		values (gen_random_uuid(), ${ids.orgA}, ${equipment!.id}, 'Clean', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', ${task!.id}, ${ids.alice}) returning task_id`;
	assert.equal(reservation!.taskId, task!.id);
});
