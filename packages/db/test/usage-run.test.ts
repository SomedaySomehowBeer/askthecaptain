import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withTenant } from '../src/context.ts';
import { databaseUrl, freshDatabase, type Harness } from './harness.ts';

/** model_usage.run_id points at a workflow run in the same tenant (#38). */
const it = databaseUrl ? test : test.skip;
let db: Harness;
const ids = { orgA: '', orgB: '', alice: '', runA: '', runB: '' };

before(async () => {
	if (!databaseUrl) return;
	db = await freshDatabase();
	const [a] = await db.owner`insert into organisations (name) values ('A') returning id`;
	const [b] = await db.owner`insert into organisations (name) values ('B') returning id`;
	const [alice] = await db.owner`insert into users (email, name) values ('alice@example.com', 'Alice') returning id`;
	Object.assign(ids, { orgA: a!.id, orgB: b!.id, alice: alice!.id });
	await db.owner`insert into memberships (organisation_id, user_id, role) values (${ids.orgA}, ${ids.alice}, 'owner')`;
	await db.owner`insert into workflow_definitions (key, version, name, description, job, triggers, parameters, steps, digest) values ('inbox-triage', 1, 'Inbox triage', 'x', 1, '[]', '{}', '[]', 'abc')`;
	for (const org of ['orgA', 'orgB'] as const) {
		const [e] = await db.owner`insert into workflow_enablements (organisation_id, definition_key, definition_version) values (${ids[org]}, 'inbox-triage', 1) returning id`;
		const [r] = await db.owner`insert into workflow_runs (organisation_id, enablement_id, definition_key, definition_version, definition_digest, trigger) values (${ids[org]}, ${e!.id}, 'inbox-triage', 1, 'abc', '{}') returning id`;
		ids[org === 'orgA' ? 'runA' : 'runB'] = r!.id;
	}
});
after(async () => { await db?.close(); });

const usage = (org: string, runId: string | null) => `insert into model_usage (organisation_id, run_id, step_key, tier, provider, model, input_tokens, output_tokens, latency_ms) values ('${org}', ${runId ? `'${runId}'` : 'null'}, 'classifyThread', 'small', 'claude', 'claude-sonnet-5', 1, 1, 1) returning id`;

it('a usage row may point only at a run in its own tenant, and outlives the run', async () => {
	await assert.rejects(withTenant(db.app, { organisationId: ids.orgA, userId: ids.alice }, (tx) => tx.unsafe(usage(ids.orgA, ids.runB))), /violates foreign key/);
	const [row] = await withTenant(db.app, { organisationId: ids.orgA, userId: ids.alice }, (tx) => tx.unsafe<{ id: string }[]>(usage(ids.orgA, ids.runA)));
	assert.ok(row?.id);
	await db.owner`delete from workflow_runs where id = ${ids.runA}`;
	const [after] = await db.owner`select run_id from model_usage where id = ${row!.id}`;
	assert.equal(after!.runId, null, 'the run is gone; the usage record stays');
});
