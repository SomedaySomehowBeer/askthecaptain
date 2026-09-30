/** Synthetic list states only. No credentials or API requests; writes answer unavailable. */
import type { ApiClient } from '../src/auth/contracts.ts';
import { createWebCalls } from '../src/account/web-calls.ts';
export function passkeyHarness(scenario: string, accountEpoch: () => string | null) {
 const client: ApiClient = {
  async get(_path, _token, parse) {
   if (scenario === 'passkeys-failed') return { ok: false, kind: 'unavailable', status: 503 };
   return { ok: true, value: parse({ available: scenario !== 'passkeys-unavailable', passkeys: scenario === 'passkeys-loaded' ? [{ id: '00000000-0000-4000-8000-000000000005', name: 'Harness phone', backedUp: true, deviceType: 'multiDevice', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null }] : [] }) };
  },
  async post() { return { ok: false, kind: 'unavailable', status: 503 }; },
  async delete() { return { ok: false, kind: 'unavailable', status: 503 }; }
 };
 return createWebCalls(client, 'https://harness.invalid', { accountEpoch, accepted() {}, sessionEnded() {} });
}
