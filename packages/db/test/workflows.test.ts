import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

/** Cross-tenant tests for the workflow tables (D6): enablements, runs and run steps. The catalogue
 *  is platform-level and readable by everyone. */
const it = databaseUrl ? test : test.skip;
let db: Harness;
const ids = { orgA: '', orgB: '', alice: '', bob: '', enableA: '', enableB: '', runB: '' };

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const [a] = await db.owner`insert into organisations (name) values ('A') returning id`;
	const [b] = await db.owner`insert into organisations (name) values ('B') returning id`;
	const [alice] = await db.owner`insert into users (email, name) values ('alice@example.com', 'Alice') returning id`;
	const [bob] = await db.owner`insert into users (email, name) values ('bob@example.com', 'Bob') returning id`;
	Object.assign(ids, { orgA: a!.id, orgB: b!.id, alice: alice!.id, bob: bob!.id });
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${ids.orgA}, ${ids.alice}, 'owner'), (${ids.orgB}, ${ids.bob}, 'owner')`;
	await db.owner`insert into workflow_definitions (key, version, name, description, job, triggers, parameters, steps, digest) values ('inbox-triage', 1, 'Inbox triage', 'x', 1, '[]', '{}', '[]', 'abc')`;
	const [ea] = await db.owner`insert into workflow_enablements (organisation_id, definition_key, definition_version, enabled, enabled_by) values (${ids.orgA}, 'inbox-triage', 1, true, ${ids.alice}) returning id`;
	const [eb] = await db.owner`insert into workflow_enablements (organisation_id, definition_key, definition_version, enabled, enabled_by) values (${ids.orgB}, 'inbox-triage', 1, true, ${ids.bob}) returning id`;
	const [rb] = await db.owner`insert into workflow_runs (organisation_id, enablement_id, definition_key, definition_version, definition_digest, trigger) values (${ids.orgB}, ${eb!.id}, 'inbox-triage', 1, 'abc', '{"kind":"manual"}') returning id`;
	await db.owner`insert into workflow_run_steps (organisation_id, run_id, path, kind, key) values (${ids.orgB}, ${rb!.id}, 'steps.0', 'read', 'gmail.newThreads')`;
	Object.assign(ids, { enableA: ea!.id, enableB: eb!.id, runB: rb!.id });
});
after(async () => { await db?.close(); });

const asA = <T>(work: Parameters<typeof withTenant<T>>[2]) => withTenant<T>(db.app, { organisationId: ids.orgA, userId: ids.alice }, work);

it('the catalogue is readable without a tenant; tenant tables are not', async () => {
	assert.equal((await db.app`select key from workflow_definitions`).length, 1);
	for (const table of ['workflow_enablements', 'workflow_runs', 'workflow_run_steps']) assert.equal((await db.app.unsafe(`select id from ${table}`)).length, 0, table);
});

it('a tenant sees only its own enablements, runs and steps', async () => {
	const seen = await asA(async (tx) => ({
		enablements: (await tx`select id from workflow_enablements`).map((r) => r.id), runs: (await tx`select id from workflow_runs`).map((r) => r.id), steps: (await tx`select id from workflow_run_steps`).map((r) => r.id)
	}));
	assert.deepEqual(seen, { enablements: [ids.enableA], runs: [], steps: [] });
});

it('a tenant cannot write into another tenant, directly or by referencing its rows', async () => {
	await assert.rejects(asA((tx) => tx`insert into workflow_runs (organisation_id, enablement_id, definition_key, definition_version, definition_digest, trigger) values (${ids.orgB}, ${ids.enableB}, 'inbox-triage', 1, 'abc', '{}')`), /row-level security/);
	await assert.rejects(asA((tx) => tx`insert into workflow_runs (organisation_id, enablement_id, definition_key, definition_version, definition_digest, trigger) values (${ids.orgA}, ${ids.enableB}, 'inbox-triage', 1, 'abc', '{}')`), /violates foreign key/);
	await assert.rejects(asA((tx) => tx`insert into workflow_run_steps (organisation_id, run_id, path, kind, key) values (${ids.orgA}, ${ids.runB}, 'steps.0', 'read', 'x')`), /violates foreign key/);
	assert.equal((await asA((tx) => tx`update workflow_runs set state = 'failed' where id = ${ids.runB} returning id`)).length, 0);
	assert.equal((await asA((tx) => tx`delete from workflow_enablements where id = ${ids.enableB} returning id`)).length, 0);
	await assert.rejects(db.owner`insert into workflow_enablements (organisation_id, definition_key, definition_version) values (${ids.orgA}, 'inbox-triage', 1)`, /unique/);
	await assert.rejects(db.owner`insert into workflow_enablements (organisation_id, definition_key, definition_version) values (${ids.orgA}, 'nope', 1)`, /foreign key/);
});
