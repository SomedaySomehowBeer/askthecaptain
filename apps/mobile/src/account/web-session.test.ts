import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiClient, ApiOutcome, Parse } from '../auth/contracts.ts';
import { apiPaths, organisationPath } from '../api/paths.ts';
import { createWebSession } from './web-session.ts';

const user = { id: '00000000-0000-4000-8000-000000000001', email: 'person@example.test', name: 'Person' };
const a = { organisationId: '00000000-0000-4000-8000-000000000002', organisationName: 'First', role: 'owner', status: 'active' };
const b = { ...a, organisationId: '00000000-0000-4000-8000-000000000003', organisationName: 'Second' };
const me = (memberships = [a]) => ({ user, memberships, passkeyVerified: false });
const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function harness(remembered: string | null = null) {
 let now = 0;
 const calls: { path: string; token: string | null; body?: unknown; answer(value: unknown): void; fail(outcome: ApiOutcome<never>): void }[] = [];
 const timers = new Map<number, { at: number; run(): void }>(); let nextTimer = 0;
 const request = <T>(path: string, token: string | null, parse: Parse<T>, body?: unknown): Promise<ApiOutcome<T>> => new Promise(resolve => {
  calls.push({ path, token, body, answer(value) { try { resolve({ ok: true, value: parse(value) }); } catch { resolve({ ok: false, kind: 'unavailable', status: 200 }); } }, fail: resolve });
 });
 const client: ApiClient = { get: (path, token, parse) => request(path, token, parse), post: (path, token, body, parse) => request(path, token, parse, body) };
 const writes: string[][] = [];
 const source = createWebSession({ client, origin: 'https://captain.example.test', memory: { read: () => remembered, write: (u, o) => { writes.push([u, o]); return true; }, forget: () => {} }, monotonicNow: () => now, wallNow: () => 1_800_000_000_000 + now, timers: { set: (ms, run) => { const id = ++nextTimer; timers.set(id, { at: now + ms, run }); return id; }, clear: id => { timers.delete(id as number); } } });
 return { source, calls, writes, view: () => source.snapshot().account, async tick(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } await flush(); }, async signedIn(memberships = [a]) { source.start(); calls[0]!.answer(me(memberships)); await flush(); } };
}

test('cookie identity is checked once; remembers only a per-person organisation, with no bearer', async () => {
 const h = harness(b.organisationId); await h.signedIn([a, b]); h.source.start();
 const view = h.view(); assert.equal(view.kind, 'signed-in'); if (view.kind !== 'signed-in') return;
 assert.equal(view.org.kind, 'chosen'); if (view.org.kind === 'chosen') assert.equal(view.org.membership.organisationId, b.organisationId);
 assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.token, null);
 h.source.send({ type: 'choose-organisation', organisationId: a.organisationId });
 assert.deepEqual(h.writes, [[user.id, a.organisationId]]);
});

test('only 401 means signed out; malformed identity and network failures pace retries and honour Retry-After', async () => {
 const h = harness(); h.source.start(); h.calls[0]!.answer({}); await flush();
 assert.equal(h.view().kind, 'unverified'); h.source.send({ type: 'retry' }); assert.equal(h.calls.length, 1);
 await h.tick(30_000); assert.equal(h.calls.length, 2);
 h.calls[1]!.fail({ ok: false, kind: 'unavailable', status: 429, retryAfter: 90 }); await flush();
 await h.tick(89_999); h.source.send({ type: 'retry' }); assert.equal(h.calls.length, 2);
 await h.tick(1); assert.equal(h.calls.length, 3);
 h.calls[2]!.fail({ ok: false, kind: 'unauthorised' }); await flush(); assert.equal(h.view().kind, 'signed-out');
});

test('a late identity refresh cannot restore the account after sign-out starts, even when sign-out fails', async () => {
 for (const success of [true, false]) {
  const h = harness(); await h.signedIn(); await h.tick(30_000); h.source.send({ type: 'refresh' });
  h.source.send({ type: 'sign-out' }); h.calls[1]!.answer(me()); await flush(); assert.equal(h.view().kind, 'releasing');
  if (success) h.calls[2]!.answer({ ok: true }); else h.calls[2]!.fail({ ok: false, kind: 'unavailable', status: 503, retryAfter: 60 });
  await flush(); assert.equal(h.view().kind, success ? 'signed-out' : 'releasing');
  if (!success) { h.source.send({ type: 'retry' }); assert.equal(h.calls.length, 3); await h.tick(60_000); h.source.send({ type: 'retry' }); assert.equal(h.calls.length, 4); h.calls[3]!.answer({ ok: true }); await flush(); assert.equal(h.view().kind, 'signed-out'); }
 }
});

test('failed foreground refresh keeps verified identity and says the check failed; success clears that notice', async () => {
 const h = harness(); await h.signedIn(); await h.tick(30_000); h.source.send({ type: 'refresh' });
 h.calls[1]!.fail({ ok: false, kind: 'unavailable', status: 0 }); await flush();
 let view = h.view(); assert.equal(view.kind, 'signed-in'); if (view.kind === 'signed-in') assert.equal(view.notice?.kind, 'refresh-unavailable');
 await h.tick(30_000); assert.equal(h.calls.length, 3, 'failed refresh retries at the paced deadline'); h.source.send({ type: 'refresh' }); h.calls[2]!.answer(me()); await flush();
 view = h.view(); if (view.kind === 'signed-in') assert.equal(view.notice, null);
});

test('accepted invitation supersedes an older membership refresh and reconciles after it settles', async () => {
 const h = harness(); await h.signedIn(); await h.tick(30_000); h.source.send({ type: 'refresh' });
 const accepted = h.source.web!.acceptInvitation('invitation'); h.calls[2]!.answer(b); await accepted;
 h.calls[1]!.answer(me()); await flush();
 const view = h.view(); assert.equal(view.kind, 'signed-in'); if (view.kind === 'signed-in' && view.org.kind === 'chosen') assert.equal(view.org.membership.organisationId, b.organisationId);
 assert.equal(h.calls[3]!.path, apiPaths.me); h.calls[3]!.answer(me([a, b])); await flush();
});

test('late organisation data is discarded across a switch; a same-person 401 still ends the session', async () => {
 for (const expired of [false, true]) {
  const h = harness(); await h.signedIn([a, b]); const view = h.view(); assert.equal(view.kind, 'signed-in'); if (view.kind !== 'signed-in' || !view.scope) return;
  const read = h.source.read(view.scope, scope => organisationPath(scope.organisationId), value => value);
  h.source.send({ type: 'choose-organisation', organisationId: b.organisationId });
  if (expired) h.calls[1]!.fail({ ok: false, kind: 'unauthorised' }); else h.calls[1]!.answer({ old: 'data' });
  assert.deepEqual(await read, { kind: 'superseded' }); assert.equal(h.view().kind, expired ? 'signed-out' : 'signed-in');
 }
});

test('passkey reads are person-scoped and expire the session on 401', async () => {
 const h = harness(); await h.signedIn(); const pending = h.source.web!.passkeys();
 h.source.send({ type: 'sign-out' }); h.calls[1]!.answer({ available: true, passkeys: [] });
 assert.equal((await pending).ok, false);
 const other = harness(); await other.signedIn(); const denied = other.source.web!.passkeys(); other.calls[1]!.fail({ ok: false, kind: 'unauthorised' }); await denied; assert.equal(other.view().kind, 'signed-out');
});

test('an uncertain invitation reconciles memberships without replaying the write', async () => {
 const h = harness(); await h.signedIn(); const pending = h.source.web!.acceptInvitation('invite');
 h.calls[1]!.fail({ ok: false, kind: 'unavailable', status: 0 }); assert.deepEqual(await pending, { kind: 'unknown' });
 assert.equal(h.calls[2]!.path, apiPaths.me); h.calls[2]!.answer(me([a, b])); await flush();
 const view = h.view(); assert.equal(view.kind, 'signed-in'); if (view.kind === 'signed-in') assert.equal(view.memberships.length, 2);
 assert.equal(h.calls.filter(call => call.path === apiPaths.acceptInvitation).length, 1);
});

test('an old revocation cannot cancel the next person’s slow timer or overwrite their result', async () => {
 const h = harness(); await h.signedIn(); const first = h.view(); if (first.kind !== 'signed-in') throw new Error('signed-in fixture');
 const old = h.source.revokeOthers(first.person);
 await h.tick(30_000); h.source.send({ type: 'refresh' }); h.calls[2]!.answer({ ...me(), user: { ...user, id: '00000000-0000-4000-8000-000000000099' } }); await flush();
 const second = h.view(); if (second.kind !== 'signed-in') throw new Error('signed-in fixture');
 const current = h.source.revokeOthers(second.person); h.calls[1]!.answer({ ended: 100 }); await old;
 await h.tick(10_001); assert.equal(h.source.revocationView().inFlight, true); assert.equal(h.source.revocationView().slow, true);
 h.calls[3]!.answer({ ended: 2 }); await current; assert.equal(h.source.revocationView().inFlight, false);
});
