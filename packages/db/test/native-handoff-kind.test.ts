import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyMigrations } from '../src/migrate.ts';
import { databaseUrl, freshDatabase } from './harness.ts';

// Migration 0044 (mobile foundation contract §3, A1): adds the `native_handoff` auth request kind and keeps
// every existing kind, including rows written before it.
const it = databaseUrl ? test : test.skip;
const existing = ['oauth', 'session_exchange', 'google_connection', 'xero_connection', 'xero_selection', 'passkey_challenge', 'shopify_connection'];
const REFUSED = { code: '23514' }; // check_violation

it('0044 keeps every existing auth request kind and its rows, adds native_handoff and still refuses unknown kinds', async () => {
	const old = await freshDatabase({ through: '0043_chat_personal_pins.sql' });
	try {
		const [user] = await old.owner`insert into users (email) values (${`${randomUUID()}@example.test`}) returning id`;
		const insert = (kind: string) => old.app`insert into auth_requests (kind, token_hash, user_id, expires_at)
			values (${kind}, ${randomUUID()}, ${user!.id}, now() + interval '1 minute')`;
		for (const kind of existing) await insert(kind);
		await assert.rejects(insert('native_handoff'), REFUSED, 'not accepted before 0044');
		assert.deepEqual(await applyMigrations(old.owner, undefined, '0044_native_handoff.sql'), ['0044_native_handoff.sql']);
		const kinds = (await old.owner<{ kind: string }[]>`select kind from auth_requests order by kind`).map((r) => r.kind);
		assert.deepEqual(kinds, [...existing].sort(), 'rows written before 0044 are kept');
		for (const kind of [...existing, 'native_handoff']) await insert(kind);
		await assert.rejects(insert('bogus'), REFUSED);
		const [constraint] = await old.owner<{ count: number }[]>`select count(*)::int as count from pg_constraint
			where conrelid = 'auth_requests'::regclass and contype = 'c' and conname = 'auth_requests_kind_check'`;
		assert.equal(constraint!.count, 1, 'exactly one named kind check');
	} finally { await old.close(); }
});
