import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMigrations } from '../src/migrate.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

// Migration 0038 (#133 step 4): the generated Obligations container is removed once the operational
// legacy reset has cleared what referred to it. The migration deletes no work: anything still
// attached stops it, by name, and leaves the database as it was.
const it = databaseUrl ? test : test.skip;
const through = '0037_retire_assistant_workflows.sql';

async function tenant(db: Harness, name: string) {
	const [org] = await db.owner`insert into organisations (name) values (${name}) returning id`;
	const [user] = await db.owner`insert into users (email) values (${name + '@example.test'}) returning id`;
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
	const [book] = await db.owner`insert into projects (organisation_id, name, description, system_kind) values (${org!.id}, 'Obligations', 'Returns, renewals and payments the business owes on a date.', 'obligations') returning id`;
	return { org: String(org!.id), user: String(user!.id), book: String(book!.id) };
}
const applied = async (db: Harness) => (await db.owner`select name from schema_migrations where name like '0038%'`).length === 1;

it('empty generated containers are deleted and audited; ordinary projects and their work stay', async () => {
	const db = await freshDatabase({ through });
	try {
		const a = await tenant(db, 'a'), b = await tenant(db, 'b');
		const [plain] = await db.owner`insert into projects (organisation_id, name) values (${a.org}, 'Production') returning id`;
		const [task] = await db.owner`insert into tasks (organisation_id, project_id, title) values (${a.org}, ${plain!.id}, 'Brew') returning id`;
		assert.deepEqual(await applyMigrations(db.owner, undefined, '0038_optional_projects.sql'), ['0038_optional_projects.sql']);
		assert.deepEqual((await db.owner`select id from projects order by id`).map((r) => r.id), [plain!.id], 'only the generated containers are removed');
		assert.equal((await db.owner`select project_id from tasks where id = ${task!.id}`)[0]!.projectId, plain!.id);
		for (const t of [a, b]) {
			const events = await db.owner`select action, subject_id, actor_kind, detail from audit_events where organisation_id = ${t.org} and detail->>'migration' = '0038'`;
			assert.deepEqual(events.map((e) => [e.action, e.subjectId, e.actorKind]), [['project.deleted', t.book, 'system']]);
		}
		const [column] = await db.owner`select count(*)::int as n from information_schema.columns where table_name = 'projects' and column_name = 'system_kind'`;
		assert.equal(column!.n, 0);
	} finally { await db.close(); }
});

it('anything still attached stops the migration by name and changes nothing, until the reset finishes', async () => {
	const db = await freshDatabase({ through });
	try {
		const a = await tenant(db, 'a');
		const [task] = await db.owner`insert into tasks (organisation_id, project_id, title, status) values (${a.org}, ${a.book}, 'Old suggestion', 'suggested') returning id`;
		await assert.rejects(applyMigrations(db.owner, undefined, '0038_optional_projects.sql'), /tasks\.project_id still refers to a system Obligations project/);
		assert.equal(await applied(db), false);
		assert.equal((await db.owner`select count(*)::int as n from projects where id = ${a.book}`)[0]!.n, 1, 'rolled back: nothing deleted');
		assert.equal((await db.owner`select project_id from tasks where id = ${task!.id}`)[0]!.projectId, a.book, 'no work is moved or deleted');
		const [column] = await db.owner`select is_nullable from information_schema.columns where table_name = 'tasks' and column_name = 'project_id'`;
		assert.equal(column!.isNullable, 'NO', 'the whole migration rolled back');

		// A reference through an on-delete-set-null or no-action key stops it just the same.
		await db.owner`delete from tasks where id = ${task!.id}`;
		const [equipment] = await db.owner`insert into equipment (organisation_id, name) values (${a.org}, 'Fermenter') returning id`;
		const [reservation] = await db.owner`insert into equipment_reservations (id, organisation_id, equipment_id, title, starts_at, ends_at, occupied_starts_at, occupied_ends_at, project_id, created_by)
			values (gen_random_uuid(), ${a.org}, ${equipment!.id}, 'Clean', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', '2030-01-01T00:00:00Z', '2030-01-01T01:00:00Z', ${a.book}, ${a.user}) returning id`;
		await assert.rejects(applyMigrations(db.owner, undefined, '0038_optional_projects.sql'), /equipment_reservations\.project_id still refers/);
		assert.equal(await applied(db), false);

		await db.owner`delete from equipment_reservations where id = ${reservation!.id}`;
		assert.deepEqual(await applyMigrations(db.owner, undefined, '0038_optional_projects.sql'), ['0038_optional_projects.sql'], 'applies once the reset has finished');
		assert.equal((await db.owner`select count(*)::int as n from projects`)[0]!.n, 0);
	} finally { await db.close(); }
});
