import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { connect } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { runtimeRoleIsSafe, requireSafeRuntimeRole } from './runtime-role.ts';

const it = databaseUrl ? test : test.skip;
let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); });
after(async () => { await db?.close(); });

it('accepts the ordinary runtime connection and rejects the migration owner', async () => {
	assert.equal(await runtimeRoleIsSafe(db.app), true);
	await requireSafeRuntimeRole(db.app);
	assert.equal(await runtimeRoleIsSafe(db.owner), false);
	await assert.rejects(requireSafeRuntimeRole(db.owner), /Unsafe database runtime role/);
});

it('rejects row_security off even for the ordinary runtime role', async () => {
	await db.app.begin(async tx => {
		await tx`set local row_security = off`;
		assert.equal(await runtimeRoleIsSafe(tx), false);
	});
	assert.equal(await runtimeRoleIsSafe(db.app), true);
});

it('rejects an administrative session even after switching to the runtime role', async () => {
	await db.owner.begin(async tx => {
		await tx`set local role app`;
		assert.equal(await runtimeRoleIsSafe(tx), false);
	});
});

it('rejects privileged membership even without role switching or inherited privileges', async () => {
	const name = `runtime_probe_${randomBytes(8).toString('hex')}`;
	// A unique disposable role: never modify the cluster-wide app role used by other suites.
	await db.owner.unsafe(`create role ${name} login password 'local-test-only' nosuperuser nobypassrls nocreaterole nocreatedb`);
	const url = new URL(db.databaseUrl); url.username = name; url.password = 'local-test-only';
	const probe = connect(url.toString(), { max: 1 });
	try {
		assert.equal(await runtimeRoleIsSafe(probe), true);
		await db.owner.unsafe(`grant pg_read_all_data to ${name} with inherit false, set false`);
		assert.equal(await runtimeRoleIsSafe(probe), false);
		await db.owner.unsafe(`revoke pg_read_all_data from ${name}`);
		assert.equal(await runtimeRoleIsSafe(probe), true);
		await db.owner.unsafe(`create table public.${name} (id integer)`);
		await db.owner.unsafe(`alter table public.${name} owner to ${name}`);
		assert.equal(await runtimeRoleIsSafe(probe), false, 'an object owner can weaken its own access rules');
		await db.owner.unsafe(`drop table public.${name}`);
		assert.equal(await runtimeRoleIsSafe(probe), true);
	} finally {
		await probe.end();
		await db.owner.unsafe(`drop table if exists public.${name}`);
		await db.owner.unsafe(`drop role ${name}`);
	}
});
