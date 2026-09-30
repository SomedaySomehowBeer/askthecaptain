import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStepUpVerified, parseStepUpOptions, returnPath, createWebCalls } from './web-calls.ts';
import type { ApiClient } from '../auth/contracts.ts';

test('web step-up requires the cookie-session response; native handoffs and bearer responses are never treated as web sessions', () => {
 const answer = { ok: true, expiresAt: '2026-10-30T00:00:00.000Z', user: { id: '00000000-0000-4000-8000-000000000001', name: 'Person', email: 'person@example.test' }, returnTo: '/equipment' };
 assert.deepEqual(parseStepUpVerified(answer), { returnTo: '/equipment' });
 for (const invalid of [{}, { returnTo: '/' }, { nativeHandoff: 'code', attempt: 'attempt' }, { ...answer, token: 'must-not-enter-ui' }, { ...answer, ok: false }]) assert.throws(() => parseStepUpVerified(invalid));
 for (const target of ['https://outside.example', '//outside.example', '/auth/passkey']) assert.deepEqual(parseStepUpVerified({ ...answer, returnTo: target }), { returnTo: '/' });
 assert.throws(() => parseStepUpOptions({ options: null }));
});

test('sign-in keeps safe destinations and discards external or sign-in destinations', () => {
 for (const path of ['//other.example', 'https://other.example', '/welcome?error=failed', '/auth/passkey']) assert.equal(returnPath(path), '/');
 assert.equal(returnPath('/invitations/accept?token=invite'), '/invitations/accept?token=invite');
});

test('invitation writes never retry an uncertain single-use response and discard results after the person changes', async () => {
 let epoch: string | null = 'one'; let sends = 0; let accepted = 0;
 let resolve!: (value: any) => void;
 const client: ApiClient = { patch: async () => ({ ok: false, kind: 'unavailable', status: 0 }), delete: async () => ({ ok: false, kind: 'unavailable', status: 0 }), get: async () => ({ ok: false, kind: 'unavailable', status: 0 }), post: () => { sends++; return new Promise(done => { resolve = done; }); } };
 const web = createWebCalls(client, 'https://captain.example.test', { accountEpoch: () => epoch, accepted: () => { accepted++; }, sessionEnded: () => {} });
 const lost = web.acceptInvitation('invite'); resolve({ ok: false, kind: 'unavailable', status: 0 }); assert.deepEqual(await lost, { kind: 'unknown' }); assert.equal(sends, 1);
 const stale = web.acceptInvitation('invite'); epoch = 'two'; resolve({ ok: true, value: {} }); assert.deepEqual(await stale, { kind: 'stale' }); assert.equal(accepted, 0);
});

 test('native passkey step-up preserves only the fixed PKCE handoff, never a web session or a supplied URL', () => {
 const nativeHandoff = 'nh_' + 'a'.repeat(43), attempt = 'b'.repeat(43);
 assert.deepEqual(parseStepUpVerified({ nativeHandoff, attempt }, true), { returnTo: `app.askthecaptain.dev:/auth/callback?code=${nativeHandoff}&attempt=${attempt}` });
 for (const value of [{ nativeHandoff, attempt, returnTo: 'https://outside.example' }, { nativeHandoff: 'bad', attempt }, { ok: true, returnTo: '/' }]) assert.throws(() => parseStepUpVerified(value, true));
 });
