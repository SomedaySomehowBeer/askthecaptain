/** Synthetic list states for the production Members screen; no network, writes answer unavailable. */
import type { ApiClient } from '../src/auth/contracts.ts';
import type { MemberScope } from '../src/account/members.ts';
import { createWebCalls } from '../src/account/web-calls.ts';
export function memberHarness(scenario: string, scope: () => MemberScope | null) {
 const client: ApiClient = {
  async get(path, _token, parse) {
   if (scenario === 'members-failed') return { ok: false, kind: 'unavailable', status: 503 };
   if (scenario === 'members-refused') return { ok: false, kind: 'refused', status: 403, code: 'forbidden' };
   const actor = scope();
   const rows = scenario === 'members-empty' || !actor ? [] : [{ userId: actor.userId, name: 'Sam Skipper', email: 'skipper@example.test', role: actor.role, status: 'active', since: '2026-09-01T00:00:00.000Z' }];
   return { ok: true, value: parse(path.endsWith('/members') ? { members: rows } : { invitations: [] }) };
  },
  async post() { return { ok: false, kind: 'unavailable', status: 503 }; },
  async patch() { return { ok: false, kind: 'unavailable', status: 503 }; },
  async delete() { return { ok: false, kind: 'unavailable', status: 503 }; }
 };
 return createWebCalls(client, 'https://harness.invalid', { memberScope: scope, accountEpoch: () => scope()?.epoch ?? null, accepted() {}, sessionEnded() {} });
}
