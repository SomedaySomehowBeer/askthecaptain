import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiClient, ApiOutcome, Parse } from '../auth/contracts.ts';
import { createMemberControls } from './member-controls.ts';
import { createMembersCalls, memberChangeAllowed, parseMembers, parseInvitations, parseCreatedInvitation, type MemberScope, type MembersData } from './members.ts';
const owner = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002', org = '00000000-0000-4000-8000-000000000003', inv = '00000000-0000-4000-8000-000000000004';
const scope: MemberScope = { epoch: 'one', userId: owner, organisationId: org, role: 'owner' };
const member = (userId: string, role: 'owner' | 'admin' | 'member') => ({ userId, role, name: 'Person', email: `${userId}@example.test`, status: 'active', since: '2026-09-01T00:00:00.000Z' });
const invitation = { id: inv, email: 'new@example.test', role: 'member', invitedBy: owner, expiresAt: '2026-10-07T00:00:00.000Z', acceptedAt: null, revokedAt: null, createdAt: '2026-09-30T00:00:00.000Z' };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture() {
 let current: MemberScope | null = scope, now = 0, ended = 0, reconciled = 0;
 let members: unknown = { members: [member(owner, 'owner'), member(other, 'member')] }, invitations: unknown = { invitations: [] };
 let failure: ApiOutcome<never> | null = null;
 let hold: (() => Promise<void>) | null = null;
 const sent: { method: string; path: string; token: string | null; body?: unknown }[] = [];
 async function request<T>(method: string, path: string, token: string | null, parse: Parse<T>, body?: unknown): Promise<ApiOutcome<T>> {
  sent.push({ method, path, token, body }); if (hold) await hold(); if (failure) return failure;
  let value: unknown = { ok: true };
  if (method === 'GET') value = path.endsWith('/members') ? members : invitations;
  if (method === 'POST') { invitations = { invitations: [invitation] }; value = { invitation, token: 'inv_' + 'a'.repeat(43) }; }
  try { return { ok: true, value: parse(value) }; } catch { return { ok: false, kind: 'unavailable', status: 200 }; }
 }
 const client: ApiClient = { get: (p, t, parse) => request('GET', p, t, parse), post: (p, t, b, parse) => request('POST', p, t, parse, b), patch: (p, t, b, parse) => request('PATCH', p, t, parse, b), delete: (p, t, parse) => request('DELETE', p, t, parse) };
 const calls = createMembersCalls(client, 'https://captain.example.test', { scope: () => current, sessionEnded() { ended++; current = null; }, reconcile() { reconciled++; } });
 const controls = createMemberControls(calls, scope, () => now);
 return { calls, controls, sent, current(value: MemberScope | null) { current = value; }, fail(value: ApiOutcome<never> | null) { failure = value; }, hold(fn: (() => Promise<void>) | null) { hold = fn; }, rows(value: unknown) { members = value; }, time(value: number) { now = value; }, ended: () => ended, reconciled: () => reconciled };
}
test('strict list parsing rejects duplicates, removed members, extra data and over-budget lists', () => {
 const row = member(owner, 'owner');
 assert.equal(parseMembers({ members: [row] })[0]!.userId, owner);
 for (const value of [{ members: [row, row] }, { members: [{ ...row, status: 'removed' }] }, { members: [{ ...row, token: 'secret' }] }, { members: new Array(501).fill(row) }, { members: [{ ...row, since: 'yesterday' }] }]) assert.throws(() => parseMembers(value));
 for (const value of [{ invitations: [invitation, invitation] }, { invitations: [{ ...invitation, acceptedAt: invitation.createdAt }] }, { invitations: [{ ...invitation, role: 'owner' }] }]) assert.throws(() => parseInvitations(value));
 assert.throws(() => parseCreatedInvitation({ invitation, token: 'https://outside.example/' }));
});
test('member calls use one tenant, null bearer, PATCH/DELETE and the returned one-time invitation token', async () => {
 const f = fixture(); await f.controls.refresh(); await f.controls.change({ kind: 'invite', email: 'new@example.test', role: 'member' });
 assert.equal(f.controls.snapshot().invitation?.url, 'https://captain.example.test/invitations/accept?token=inv_' + 'a'.repeat(43));
 assert.match(f.controls.snapshot().message, /No email was sent/);
 await f.controls.change({ kind: 'role', userId: other, role: 'admin' }); await f.controls.change({ kind: 'remove', userId: other });
 assert.ok(f.sent.every(s => s.token === null && s.path.startsWith(`/v1/organisations/${org}/`)));
 assert.ok(f.sent.some(s => s.method === 'PATCH' && (s.body as {role:string}).role === 'admin'));
 assert.ok(f.sent.some(s => s.method === 'DELETE')); assert.equal(f.controls.snapshot().invitation, null);
});
test('owner/admin rules preserve the last owner and prevent admins granting or changing ownership', () => {
 const data: MembersData = { members: parseMembers({ members: [member(owner, 'owner'), member(other, 'admin')] }), invitations: [] };
 assert.equal(memberChangeAllowed(data, scope, { kind: 'remove', userId: owner }), false);
 assert.equal(memberChangeAllowed(data, scope, { kind: 'role', userId: owner, role: 'member' }), false);
 assert.equal(memberChangeAllowed(data, scope, { kind: 'role', userId: other, role: 'owner' }), true);
 const admin = { ...scope, userId: other, role: 'admin' as const };
 for (const action of [{ kind: 'remove', userId: owner }, { kind: 'role', userId: owner, role: 'admin' }, { kind: 'role', userId: other, role: 'owner' }] as const) assert.equal(memberChangeAllowed(data, admin, action), false);
 const two = { ...data, members: parseMembers({ members: [member(owner, 'owner'), member(other, 'owner')] }) };
 assert.equal(memberChangeAllowed(two, scope, { kind: 'remove', userId: owner }), true);
});
test('no API reads or writes for a member or stale organisation', async () => {
 const f = fixture(); const regular = { ...scope, role: 'member' as const }; f.current(regular);
 assert.deepEqual(await f.calls.load(regular), { kind: 'refused', code: 'forbidden' });
 await f.calls.change(regular, { kind: 'invite', email: 'new@example.test', role: 'member' });
 assert.deepEqual(await f.calls.load(scope), { kind: 'stale' }); assert.equal(f.sent.length, 0);
});
test('scope change during member read prevents invitation read', async () => {
 const f = fixture(); let release!: () => void; f.hold(() => new Promise(resolve => { release = resolve; }));
 const result = f.calls.load(scope); f.current({ ...scope, organisationId: other, epoch: 'two' }); release();
 assert.deepEqual(await result, { kind: 'stale' }); assert.equal(f.sent.length, 1);
});
test('a late invitation link cannot enter a new scope or a disposed screen', async () => {
 for (const dispose of [false, true]) {
  const f = fixture(); await f.controls.refresh(); let release!: () => void; f.hold(() => new Promise(resolve => { release = resolve; }));
  const change = f.controls.change({ kind: 'invite', email: 'new@example.test', role: 'member' });
  if (dispose) f.controls.dispose(); else f.current({ ...scope, epoch: 'two', userId: other });
  release(); await change; assert.equal(f.controls.snapshot().invitation, null); assert.equal(f.sent.length, 3);
 }
});
test('a late 401 cannot end a newer person session; a current 401 ends this one', async () => {
 const f = fixture(); let release!: () => void; f.hold(() => new Promise(resolve => { release = resolve; }));
 const read = f.calls.load(scope); f.current({ ...scope, epoch: 'two' }); f.fail({ ok: false, kind: 'unauthorised' }); release(); await read; assert.equal(f.ended(), 0);
 f.hold(null); f.current(scope); await f.calls.load(scope); assert.equal(f.ended(), 1);
});
test('demotion found in the member list blocks invitation reads and reconciles identity', async () => {
 const f = fixture(); f.rows({ members: [member(owner, 'member')] }); const result = await f.calls.load(scope);
 assert.deepEqual(result, { kind: 'refused', code: 'forbidden' }); assert.equal(f.sent.length, 1); assert.equal(f.reconciled(), 1);
});
test('uncertain invitations are not replayed, respect Retry-After and require successful reconciliation', async () => {
 const f = fixture(); await f.controls.refresh(); f.fail({ ok: false, kind: 'unavailable', status: 503, retryAfter: 5 });
 const action = { kind: 'invite', email: 'new@example.test', role: 'member' } as const;
 await f.controls.change(action); assert.match(f.controls.snapshot().message, /lost link cannot be retrieved/); assert.equal(f.controls.snapshot().invitation, null);
 await f.controls.change(action); await f.controls.refresh(); assert.equal(f.sent.length, 3);
 f.time(5000); await f.controls.change(action); assert.equal(f.sent.length, 3);
 await f.controls.refresh(); assert.equal(f.controls.snapshot().phase, 'failed'); f.fail(null); f.time(10000); await f.controls.refresh();
 assert.equal(f.controls.snapshot().needsRefresh, false); assert.equal(f.controls.snapshot().message, '');
});
test('pending write prevents double submissions, list refresh and another mutation', async () => {
 const f = fixture(); await f.controls.refresh(); let release!: () => void; f.hold(() => new Promise(resolve => { release = resolve; }));
 const change = f.controls.change({ kind: 'remove', userId: other }); await flush();
 await f.controls.change({ kind: 'remove', userId: other }); await f.controls.refresh(); assert.equal(f.sent.length, 3);
 f.hold(null); release(); await change;
});
for (const [code, phrase] of [['last_owner', 'at least one owner'], ['membership_changed', 'changed while'], ['already_member', 'already a member'], ['forbidden', 'permission'], ['not_found', 'no longer available']]) {
 test(`API refusal ${code} is explicit and never success`, async () => {
  const f = fixture(); await f.controls.refresh(); f.fail({ ok: false, kind: 'refused', status: 400, code: code! });
  await f.controls.change({ kind: 'invite', email: 'new@example.test', role: 'member' }); assert.match(f.controls.snapshot().message, new RegExp(phrase!)); assert.equal(f.controls.snapshot().needsRefresh, true);
 });
}
test('invalid email, unknown member and known last owner never send writes', async () => {
 const f = fixture(); await f.controls.refresh();
 await f.controls.change({ kind: 'invite', email: 'invalid', role: 'member' }); await f.controls.change({ kind: 'remove', userId: owner }); await f.controls.change({ kind: 'remove', userId: inv });
 assert.equal(f.sent.length, 2); assert.match(f.controls.snapshot().message, /email/);
});
test('self-role writes reconcile memberships, and failed reads clear invitation links', async () => {
 const f = fixture(); await f.calls.change(scope, { kind: 'role', userId: owner, role: 'admin' }); assert.equal(f.reconciled(), 1);
 await f.controls.refresh(); await f.controls.change({ kind: 'invite', email: 'new@example.test', role: 'member' }); assert.ok(f.controls.snapshot().invitation);
 f.fail({ ok: false, kind: 'unavailable', status: 0 }); await f.controls.refresh(); assert.equal(f.controls.snapshot().invitation, null); assert.equal(f.controls.snapshot().data, null);
});
