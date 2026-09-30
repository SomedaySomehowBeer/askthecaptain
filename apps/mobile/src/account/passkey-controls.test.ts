import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiClient, ApiOutcome } from '../auth/contracts.ts';
import { createWebCalls, parseRegistration } from './web-calls.ts';
import { createPasskeyControls } from './passkey-controls.ts';
import { passkeyPath } from '../api/paths.ts';
const row = { id: '00000000-0000-4000-8000-000000000005', name: 'Phone', deviceType: 'multiDevice', backedUp: true, createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null };
const registration = { token: 'pkr_' + 'a'.repeat(43), options: { challenge: 'challenge' } };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
 let epoch: string | null = 'one', now = 0, ended = 0;
 let list: unknown = { available: true, passkeys: [row] };
 let next: ApiOutcome<never> | null = null;
 let pending: (() => Promise<void>) | null = null;
 const calls: { method: string; path: string; body?: unknown; token: string | null }[] = [];
 const client: ApiClient = { patch: async () => ({ ok: false, kind: 'unavailable', status: 0 }),
  async get(path, token, parse) { calls.push({ method: 'GET', path, token }); if (next) return next; return { ok: true, value: parse(list) }; },
  async post(path, token, body, parse) { calls.push({ method: 'POST', path, body, token }); if (pending) await pending(); if (next) return next; return { ok: true, value: parse(path.endsWith('/options') ? registration : row) }; },
  async delete(path, token, parse) { calls.push({ method: 'DELETE', path, token }); if (pending) await pending(); if (next) return next; return { ok: true, value: parse({ ok: true }) }; }
 };
 const web = createWebCalls(client, 'https://captain.example.test', { accountEpoch: () => epoch, accepted() {}, sessionEnded() { ended++; epoch = null; } });
 const controls = createPasskeyControls(web, () => now);
 return { controls, web, calls, epoch: (value: string | null) => { epoch = value; }, time: (value: number) => { now = value; }, list: (value: unknown) => { list = value; }, fail: (value: ApiOutcome<never> | null) => { next = value; }, pending: (fn: (() => Promise<void>) | null) => { pending = fn; }, ended: () => ended };
}

test('registration parser refuses bearer tokens, malformed challenges and extra fields; removal IDs cannot escape their path', () => {
 assert.deepEqual(parseRegistration(registration), registration);
 for (const invalid of [{ ...registration, token: 'sess_' + 'a'.repeat(43) }, { ...registration, options: null }, { ...registration, credential: 'secret' }]) assert.throws(() => parseRegistration(invalid));
 for (const invalid of ['', '../sessions', row.id + '/other', row.id.toUpperCase().replace('00000000', 'AAAAAAAA')]) assert.throws(() => passkeyPath(invalid));
 assert.equal(passkeyPath(row.id), '/v1/me/passkeys/' + row.id);
});
test('registration holds challenge privately, sends cookies through null bearer, then refreshes; removal uses DELETE', async () => {
 const f = fixture(); await f.controls.refresh();
 await f.controls.add(' Phone ', async options => { assert.deepEqual(options, registration.options); assert.doesNotMatch(JSON.stringify(f.controls.snapshot()), /pkr_|challenge/); return { id: 'credential' }; });
 assert.match(f.controls.snapshot().message, /added/);
 assert.deepEqual(f.calls.map(c => c.method), ['GET', 'POST', 'POST', 'GET']);
 assert.deepEqual(f.calls[2]!.body, { token: registration.token, name: 'Phone', response: { id: 'credential' } });
 assert.ok(f.calls.every(c => c.token === null));
 await f.controls.remove(row.id); assert.equal(f.calls.at(-2)!.method, 'DELETE'); assert.match(f.controls.snapshot().message, /removed/);
});
test('only one ceremony is admitted, and leaving during the browser prompt prevents registration', async () => {
 const f = fixture(); await f.controls.refresh(); let answer!: (value: unknown) => void;
 const adding = f.controls.add('Phone', () => new Promise(resolve => { answer = resolve; })); await flush();
 await f.controls.add('Other', async () => ({})); await f.controls.remove(row.id); await f.controls.refresh(); assert.equal(f.calls.length, 2);
 f.controls.dispose(); answer({ id: 'credential' }); await adding; assert.equal(f.calls.length, 2);
});
test('person change while options or browser is pending prevents the next leg', async () => {
 for (const stage of ['options', 'browser']) {
  const f = fixture(); let release!: () => void;
  if (stage === 'options') f.pending(() => new Promise<void>(resolve => { release = resolve; }));
  const adding = f.web.addPasskey('Phone', async () => { await new Promise<void>(resolve => { release = resolve; }); return {}; }, () => true);
  await flush(); f.epoch('two'); release(); assert.deepEqual(await adding, { kind: 'stale' }); assert.equal(f.calls.length, 1);
 }
});
test('a late 401 from an old person does not sign out the new person', async () => {
 const f = fixture(); let release!: () => void; f.pending(() => new Promise<void>(resolve => { release = resolve; }));
 const removing = f.web.removePasskey(row.id); f.epoch('two'); f.fail({ ok: false, kind: 'unauthorised' }); release();
 assert.deepEqual(await removing, { kind: 'stale' }); assert.equal(f.ended(), 0);
});
test('a current 401 ends the account; signed-out mutation sends nothing', async () => {
 const f = fixture(); f.fail({ ok: false, kind: 'unauthorised' }); await f.web.removePasskey(row.id); assert.equal(f.ended(), 1);
 const count = f.calls.length; await f.web.addPasskey('', async () => ({}), () => true); await f.web.removePasskey(row.id); assert.equal(f.calls.length, count);
});
for (const [name, text] of [['NotAllowedError', 'dismissed'], ['InvalidStateError', 'already has'], ['UnknownError', 'could not create']]) {
 test(`browser ${name} is bounded copy, never submits an assertion or repeats the error`, async () => {
  const f = fixture(); await f.controls.refresh(); await f.controls.add('', async () => { const error = new Error('secret-provider-message'); error.name = name!; throw error; });
  assert.match(f.controls.snapshot().message, new RegExp(text!)); assert.doesNotMatch(JSON.stringify(f.controls.snapshot()), /secret-provider/); assert.equal(f.calls.length, 2);
 });
}
test('uncertain writes do not retry and require a successful refresh; Retry-After gates reads and writes', async () => {
 const f = fixture(); await f.controls.refresh(); f.fail({ ok: false, kind: 'unavailable', status: 503, retryAfter: 5 });
 await f.controls.remove(row.id); assert.equal(f.controls.snapshot().mustRefresh, true); assert.match(f.controls.snapshot().message, /Couldn't confirm/);
 await f.controls.refresh(); await f.controls.remove(row.id); assert.equal(f.calls.length, 2);
 f.time(5000); f.fail(null); await f.controls.remove(row.id); assert.equal(f.calls.length, 2); await f.controls.refresh(); assert.equal(f.controls.snapshot().mustRefresh, false);
 await f.controls.remove(row.id); assert.equal(f.calls.length, 5);
});
test('failed, unavailable and empty are distinct, and failed refresh hides stale list controls', async () => {
 const f = fixture(); await f.controls.refresh(); f.fail({ ok: false, kind: 'unavailable', status: 0 }); await f.controls.refresh(); assert.equal(f.controls.snapshot().list, null); assert.equal(f.controls.snapshot().phase, 'failed');
 f.fail(null); f.list({ available: false, passkeys: [] }); await f.controls.refresh(); const count = f.calls.length; await f.controls.add('', async () => ({})); assert.equal(f.calls.length, count);
 f.list({ available: true, passkeys: [] }); await f.controls.refresh(); assert.equal(f.controls.snapshot().list?.available, true); assert.deepEqual(f.controls.snapshot().list?.passkeys, []);
});
test('registration refusal is not success and an expired challenge allows a fresh attempt', async () => {
 const f = fixture(); await f.controls.refresh();
 await f.controls.add('', async () => { f.fail({ ok: false, kind: 'refused', status: 400, code: 'challenge_invalid' }); return {}; });
 assert.match(f.controls.snapshot().message, /expired/); assert.equal(f.controls.snapshot().mustRefresh, false);
 f.fail(null); await f.controls.add('', async () => ({})); assert.match(f.controls.snapshot().message, /added/);
});
