import type { ApiClient } from '../src/auth/contracts.ts';
import type { MemberScope } from '../src/account/members.ts';
import { createWebCalls } from '../src/account/web-calls.ts';
export function pushHarness(scenario: string, scope: () => MemberScope | null) {
 const client: ApiClient = {
  async get(path, _token, parse) {
   if (scenario === 'push-failed') return { ok: false, kind: 'unavailable', status: 503 };
   return { ok: true, value: parse(path.endsWith('/config') ? { configured: scenario !== 'push-unavailable', publicKey: scenario === 'push-unavailable' ? null : 'B' + 'a'.repeat(86) } : { subscriptions: scenario === 'push-loaded' ? [{ id: '00000000-0000-4000-8000-000000000005', endpoint: 'https://push.example.test/synthetic', userAgent: 'Synthetic browser', createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null }] : [] }) };
  },
  async post() { return { ok: false, kind: 'unavailable', status: 503 }; },
  async patch() { return { ok: false, kind: 'unavailable', status: 503 }; },
  async delete() { return { ok: false, kind: 'unavailable', status: 503 }; }
 };
 return createWebCalls(client, 'https://harness.invalid', { memberScope: scope, accountEpoch: () => scope()?.epoch ?? null, accepted() {}, sessionEnded() {} });
}
