/** Personal push settings. Endpoints/keys stay call-local or in screen memory, never page storage. */
import type { ApiClient, ApiOutcome } from '../auth/contracts.ts';
import { apiPaths, isCanonicalInstant, isCanonicalUuid, organisationPath } from '../api/paths.ts';
import type { ReadScope } from './contracts.ts';
export type Device = { id: string; endpoint: string; userAgent: string; createdAt: string; lastUsedAt: string | null };
export type PushConfig = { configured: boolean; publicKey: string | null };
export type PushData = { config: PushConfig; devices: readonly Device[] };
export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string };
export type Delivery = { subscriptionId: string; state: 'sent' | 'failed' | 'gone' };
export type PushResult<T> = { kind: 'ok'; value: T } | { kind: 'stale' } | { kind: 'failed'; code: string; uncertain: boolean; retryAfter: number };
export type PushCalls = {
 current(scope: ReadScope): boolean;
 load(scope: ReadScope): Promise<PushResult<PushData>>;
 register(scope: ReadScope, input: PushSubscriptionInput): Promise<PushResult<Device>>;
 remove(scope: ReadScope, endpoint: string): Promise<PushResult<null>>;
 test(scope: ReadScope): Promise<PushResult<readonly Delivery[]>>;
};
const bad = (): never => { throw new TypeError('push: unexpected answer'); };
const rec = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const bounded = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
export function validEndpoint(x: unknown): x is string { if (!bounded(x, 2000) || /\s/.test(x)) return false; try { const u = new URL(x); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }
export function parsePushConfig(x: unknown): PushConfig {
 if (!rec(x) || !exact(x, ['configured', 'publicKey']) || typeof x.configured !== 'boolean' || !(x.publicKey === null || (typeof x.publicKey === 'string' && /^B[A-Za-z0-9_-]{86}$/.test(x.publicKey))) || (x.configured && x.publicKey === null)) return bad();
 return { configured: x.configured, publicKey: x.publicKey };
}
export function parseDevice(x: unknown): Device {
 if (!rec(x) || !exact(x, ['id', 'endpoint', 'userAgent', 'createdAt', 'lastUsedAt']) || !isCanonicalUuid(x.id) || !validEndpoint(x.endpoint) || !bounded(x.userAgent, 300) || !isCanonicalInstant(x.createdAt) || !(x.lastUsedAt === null || isCanonicalInstant(x.lastUsedAt))) return bad();
 return { id: x.id, endpoint: x.endpoint, userAgent: x.userAgent, createdAt: x.createdAt, lastUsedAt: x.lastUsedAt };
}
export function parseDevices(x: unknown): readonly Device[] {
 if (!rec(x) || !exact(x, ['subscriptions']) || !Array.isArray(x.subscriptions) || x.subscriptions.length > 500) return bad();
 const rows = x.subscriptions.map(parseDevice);
 if (new Set(rows.map(r => r.id)).size !== rows.length || new Set(rows.map(r => r.endpoint)).size !== rows.length) return bad();
 return rows;
}
export function parseDeliveries(x: unknown): readonly Delivery[] {
 if (!rec(x) || !exact(x, ['deliveries']) || !Array.isArray(x.deliveries) || x.deliveries.length > 500) return bad();
 const rows = x.deliveries.map((d): Delivery => {
  if (!rec(d) || !exact(d, ['subscriptionId', 'state', 'statusCode', 'error']) || !isCanonicalUuid(d.subscriptionId) || !['sent', 'failed', 'gone'].includes(String(d.state)) || !(d.statusCode === null || (Number.isInteger(d.statusCode) && Number(d.statusCode) >= 100 && Number(d.statusCode) <= 599)) || !(d.error === null || bounded(d.error, 300))) return bad();
  return { subscriptionId: d.subscriptionId, state: d.state as Delivery['state'] };
 });
 if (new Set(rows.map(r => r.subscriptionId)).size !== rows.length) return bad();
 return rows;
}
const parseDone = (x: unknown): null => { if (!rec(x) || !exact(x, ['ok']) || x.ok !== true) return bad(); return null; };
export function createPushCalls(client: ApiClient, hooks: { scope(): ReadScope | null; sessionEnded(): void; reconcile(): void }): PushCalls {
 const current = (scope: ReadScope) => { const s = hooks.scope(); return s !== null && s.epoch === scope.epoch && s.userId === scope.userId && s.organisationId === scope.organisationId; };
 const call = async <T>(scope: ReadScope, write: boolean, send: () => Promise<ApiOutcome<T>>): Promise<PushResult<T>> => {
  if (!current(scope)) return { kind: 'stale' };
  let answer: ApiOutcome<T>; try { answer = await send(); } catch { answer = { ok: false, kind: 'unavailable', status: 0 }; }
  if (!current(scope)) return { kind: 'stale' };
  if (answer.ok) return { kind: 'ok', value: answer.value };
  if (answer.kind === 'unauthorised') { hooks.sessionEnded(); return { kind: 'stale' }; }
  if (answer.kind === 'refused' && [403, 404].includes(answer.status)) hooks.reconcile();
  return { kind: 'failed', uncertain: write && answer.kind === 'unavailable', retryAfter: answer.kind === 'unavailable' ? answer.retryAfter ?? 0 : 0, code: answer.kind === 'refused' ? answer.code : 'unavailable' };
 };
 const path = (s: ReadScope) => organisationPath(s.organisationId, 'push', 'subscriptions');
 return {
  current,
  async load(scope) {
   const config = await call(scope, false, () => client.get(apiPaths.pushConfig, null, parsePushConfig));
   if (config.kind !== 'ok') return config;
   const devices = await call(scope, false, () => client.get(path(scope), null, parseDevices));
   return devices.kind === 'ok' ? { kind: 'ok', value: { config: config.value, devices: devices.value } } : devices;
  },
  register: (s, input) => call(s, true, () => client.post(path(s), null, input, parseDevice)),
  remove: (s, endpoint) => call(s, true, () => client.delete(path(s), null, parseDone, { endpoint })),
  test: s => call(s, true, () => client.post(organisationPath(s.organisationId, 'push', 'test'), null, {}, parseDeliveries))
 };
}
export function deliveryMessage(rows: readonly Delivery[]): string {
 const sent = rows.filter(r => r.state === 'sent').length, failed = rows.filter(r => r.state === 'failed').length, gone = rows.filter(r => r.state === 'gone').length;
 return rows.length ? `Push service accepted ${sent}; failed ${failed}; expired devices ${gone}. Acceptance does not confirm the notification appeared.` : 'No delivery results were returned. Check your devices before sending another test.';
}
