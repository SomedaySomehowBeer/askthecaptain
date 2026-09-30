/** Existing organisation APIs, with explicit tenant/person/role scope. No server URLs or automatic retries. */
import { isCanonicalInstant, isCanonicalUuid, organisationPath } from '../api/paths.ts';
import type { ApiClient, ApiOutcome, Parse } from '../auth/contracts.ts';
import type { ReadScope } from './contracts.ts';
import type { Role } from './me.ts';
export type MemberScope = ReadScope & { readonly role: Role };
export type Member = { readonly userId: string; readonly name: string; readonly email: string; readonly role: Role; readonly since: string };
export type Invitation = { readonly id: string; readonly email: string; readonly role: 'admin' | 'member'; readonly expiresAt: string };
export type MembersData = { readonly members: readonly Member[]; readonly invitations: readonly Invitation[] };
export type MemberAction = { kind: 'invite'; email: string; role: 'admin' | 'member' } | { kind: 'role'; userId: string; role: Role } | { kind: 'remove'; userId: string } | { kind: 'revoke'; id: string };
export type MembersResult<T> = { kind: 'ok'; value: T } | { kind: 'stale' } | { kind: 'refused'; code: string } | { kind: 'unavailable'; retryAfter: number };
export type InvitationLink = { readonly id: string; readonly email: string; readonly url: string };
export type MembersCalls = {
 load(scope: MemberScope): Promise<MembersResult<MembersData>>;
 change(scope: MemberScope, action: MemberAction): Promise<MembersResult<InvitationLink | null>>;
};
const invalid = (): never => { throw new TypeError('members: unexpected answer'); };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max;
export const isRole = (value: unknown): value is Role => value === 'owner' || value === 'admin' || value === 'member';
export const managesMembers = (role: Role) => role === 'owner' || role === 'admin';
export function parseMembers(value: unknown): readonly Member[] {
 if (!record(value) || !exact(value, ['members']) || !Array.isArray(value.members) || value.members.length > 500) return invalid();
 const rows = value.members.map((row): Member => {
  if (!record(row) || !exact(row, ['userId', 'name', 'email', 'role', 'status', 'since']) || !isCanonicalUuid(row.userId) || !text(row.name, 0, 500) || !text(row.email, 1, 320) || !isRole(row.role) || row.status !== 'active' || !isCanonicalInstant(row.since)) return invalid();
  return Object.freeze({ userId: row.userId, name: row.name, email: row.email, role: row.role, since: row.since });
 });
 if (new Set(rows.map(row => row.userId)).size !== rows.length) return invalid();
 return Object.freeze(rows);
}
export function parseInvitation(value: unknown): Invitation {
 if (!record(value) || !exact(value, ['id', 'email', 'role', 'invitedBy', 'expiresAt', 'acceptedAt', 'revokedAt', 'createdAt']) || !isCanonicalUuid(value.id) || !text(value.email, 1, 320) || (value.role !== 'member' && value.role !== 'admin') || !isCanonicalUuid(value.invitedBy) || !isCanonicalInstant(value.expiresAt) || !isCanonicalInstant(value.createdAt) || value.acceptedAt !== null || value.revokedAt !== null) return invalid();
 return Object.freeze({ id: value.id, email: value.email, role: value.role, expiresAt: value.expiresAt });
}
export function parseInvitations(value: unknown): readonly Invitation[] {
 if (!record(value) || !exact(value, ['invitations']) || !Array.isArray(value.invitations) || value.invitations.length > 500) return invalid();
 const rows = value.invitations.map(parseInvitation);
 if (new Set(rows.map(row => row.id)).size !== rows.length) return invalid();
 return Object.freeze(rows);
}
export function parseCreatedInvitation(value: unknown): { invitation: Invitation; token: string } {
 if (!record(value) || !exact(value, ['invitation', 'token']) || typeof value.token !== 'string' || !/^inv_[A-Za-z0-9_-]{43}$/.test(value.token)) return invalid();
 return { invitation: parseInvitation(value.invitation), token: value.token };
}
const parseDone = (value: unknown): null => { if (!record(value) || !exact(value, ['ok']) || value.ok !== true) return invalid(); return null; };
export const sameMemberScope = (a: MemberScope | null, b: MemberScope) => a !== null && a.epoch === b.epoch && a.userId === b.userId && a.organisationId === b.organisationId && a.role === b.role;
export function createMembersCalls(client: ApiClient, origin: string, hooks: { scope(): MemberScope | null; sessionEnded(): void; reconcile(): void }): MembersCalls {
 const current = (scope: MemberScope) => sameMemberScope(hooks.scope(), scope);
 const call = async <T>(scope: MemberScope, send: () => Promise<ApiOutcome<T>>): Promise<MembersResult<T>> => {
  if (!current(scope)) return { kind: 'stale' };
  if (!managesMembers(scope.role)) return { kind: 'refused', code: 'forbidden' };
  let answer: ApiOutcome<T>;
  try { answer = await send(); } catch { answer = { ok: false, kind: 'unavailable', status: 0 }; }
  if (!current(scope)) return { kind: 'stale' };
  if (answer.ok) return { kind: 'ok', value: answer.value };
  if (answer.kind === 'unauthorised') { hooks.sessionEnded(); return { kind: 'stale' }; }
  if (answer.kind === 'refused') { if ([403, 404, 409].includes(answer.status)) hooks.reconcile(); return { kind: 'refused', code: answer.code }; }
  return { kind: 'unavailable', retryAfter: answer.retryAfter ?? 0 };
 };
 return {
  async load(scope) {
   const members = await call(scope, () => client.get(organisationPath(scope.organisationId, 'members'), null, parseMembers));
   if (members.kind !== 'ok') return members;
   const actor = members.value.find(row => row.userId === scope.userId);
   if (actor && !managesMembers(actor.role)) { hooks.reconcile(); return { kind: 'refused', code: 'forbidden' }; }
   const invitations = await call(scope, () => client.get(organisationPath(scope.organisationId, 'invitations'), null, parseInvitations));
   return invitations.kind === 'ok' ? { kind: 'ok', value: { members: members.value, invitations: invitations.value } } : invitations;
  },
  async change(scope, action) {
   const segment = action.kind === 'remove' || action.kind === 'role' ? action.userId : action.kind === 'revoke' ? action.id : null;
   if (segment !== null && !isCanonicalUuid(segment)) return { kind: 'refused', code: 'invalid_request' };
   let result: MembersResult<InvitationLink | null>;
   if (action.kind === 'invite') {
    const parse: Parse<InvitationLink> = value => { const created = parseCreatedInvitation(value); return { id: created.invitation.id, email: created.invitation.email, url: `${origin}/invitations/accept?token=${encodeURIComponent(created.token)}` }; };
    result = await call(scope, () => client.post(organisationPath(scope.organisationId, 'invitations'), null, { email: action.email.trim(), role: action.role }, parse));
   } else if (action.kind === 'role') result = await call(scope, () => client.patch(organisationPath(scope.organisationId, 'members', action.userId), null, { role: action.role }, parseDone));
   else result = await call(scope, () => client.delete(organisationPath(scope.organisationId, action.kind === 'remove' ? 'members' : 'invitations', segment!), null, parseDone));
   if ((action.kind === 'remove' || action.kind === 'role') && action.userId === scope.userId && (result.kind === 'ok' || result.kind === 'unavailable')) hooks.reconcile();
   return result;
  }
 };
}

/** UI affordances mirror known server rules; every mutation is still authorised by the API. */
export function memberChangeAllowed(data: MembersData, scope: MemberScope, action: MemberAction): boolean {
 const actor = data.members.find(row => row.userId === scope.userId);
 if (!actor || !managesMembers(actor.role)) return false;
 if (action.kind === 'invite') return action.role === 'member' || action.role === 'admin';
 if (action.kind === 'revoke') return data.invitations.some(row => row.id === action.id);
 const target = data.members.find(row => row.userId === action.userId);
 if (!target || (target.role === 'owner' && actor.role !== 'owner')) return false;
 if (action.kind === 'role' && (!isRole(action.role) || action.role === target.role || (action.role === 'owner' && actor.role !== 'owner'))) return false;
 return !(target.role === 'owner' && data.members.filter(row => row.role === 'owner').length === 1 && (action.kind === 'remove' || action.role !== 'owner'));
}
