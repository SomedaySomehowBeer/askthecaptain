import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { ApiClient, ApiOutcome, Parse } from '../auth/contracts.ts';
import { createPushCalls, parseDevices, parsePushConfig, parseDeliveries, deliveryMessage } from './push.ts';
import { createPushControls } from './push-controls.ts';
const scope = { epoch: 'one', userId: '00000000-0000-4000-8000-000000000001', organisationId: '00000000-0000-4000-8000-000000000002' };
const device = { id: '00000000-0000-4000-8000-000000000003', endpoint: 'https://push.example.test/synthetic', userAgent: 'Synthetic browser', createdAt: '2026-10-01T00:00:00.000Z', lastUsedAt: null };
const config = { configured: true, publicKey: 'B' + 'a'.repeat(86) };
function fixture() {
 let current: typeof scope | null = scope, now = 0, ended = 0, rows = [device], failure: ApiOutcome<never> | null = null, hold: (() => Promise<void>) | null = null, prompt: (() => Promise<void>) | null = null;
 const sent: { method: string; path: string; body: unknown; token: string | null }[] = [];
 const req = async <T>(method: string, path: string, token: string | null, parse: Parse<T>, body?: unknown): Promise<ApiOutcome<T>> => {
  sent.push({ method, path, token, body }); if (hold) await hold(); if (failure) return failure;
  if (method === 'DELETE') rows = [];
  const value = path.endsWith('/config') ? config : path.endsWith('/test') ? { deliveries: [{ subscriptionId: device.id, state: 'sent', statusCode: 201, error: null }] } : method === 'GET' ? { subscriptions: rows } : method === 'DELETE' ? { ok: true } : device;
  return { ok: true, value: parse(value) };
 };
 const client: ApiClient = { get: (p,t,parse) => req('GET',p,t,parse), post: (p,t,b,parse) => req('POST',p,t,parse,b), delete: (p,t,parse,b) => req('DELETE',p,t,parse,b), patch: (p,t,b,parse) => req('PATCH',p,t,parse,b) };
 const calls = createPushCalls(client, { scope: () => current, sessionEnded() { ended++; current = null; }, reconcile() {} });
 const controls = createPushControls(calls, scope, { support: () => 'ready', async subscribe() { if (prompt) await prompt(); return { endpoint: device.endpoint, keys: { p256dh: 'synthetic', auth: 'synthetic' } }; } }, () => now);
 return { calls, controls, sent, scope(value: typeof current) { current = value; }, time(value: number) { now = value; }, fail(value: typeof failure) { failure = value; }, hold(fn: typeof hold) { hold = fn; }, prompt(fn: typeof prompt) { prompt = fn; }, ended: () => ended };
}
test('push parsers reject malformed config, duplicate devices and extra credential fields', () => {
 assert.deepEqual(parsePushConfig(config), config); assert.deepEqual(parseDevices({ subscriptions: [device] }), [device]);
 for (const x of [{ configured: true, publicKey: null }, { ...config, privateKey: 'secret' }, { ...config, publicKey: 'wrong' }]) assert.throws(() => parsePushConfig(x));
 for (const x of [{ subscriptions: [device, device] }, { subscriptions: [{ ...device, endpoint: 'http://push.example/' }] }, { subscriptions: [{ ...device, auth: 'secret' }] }]) assert.throws(() => parseDevices(x));
 assert.throws(() => parseDeliveries({ deliveries: [{ subscriptionId: device.id, state: 'arrived', statusCode: 201, error: null }] }));
});
test('register/delete/test bind to one organisation and use a DELETE body without bearer', async () => {
 const f = fixture(); await f.controls.refresh(); await f.controls.register(); await f.controls.test();
 assert.match(f.controls.snapshot().message, /does not confirm/);
 await f.controls.remove(device.endpoint);
 assert.deepEqual(f.sent.find(s => s.method === 'DELETE')?.body, { endpoint: device.endpoint });
 assert.ok(f.sent.every(s => s.token === null)); assert.deepEqual(f.controls.snapshot().data?.devices, []);
 assert.doesNotMatch(JSON.stringify(f.controls.snapshot()), /p256dh|synthetic.*auth/);
});
test('permission prompt completion after disposal or scope change cannot post a subscription', async () => {
 for (const dispose of [false, true]) {
  const f = fixture(); await f.controls.refresh(); let release!: () => void;
  f.prompt(() => new Promise(resolve => { release = resolve; })); const result = f.controls.register();
  if (dispose) f.controls.dispose(); else f.scope({ ...scope, epoch: 'two' }); release(); await result;
  assert.equal(f.sent.length, 2);
 }
});
test('scope loss between config and subscriptions suppresses the second read', async () => {
 const f = fixture(); let release!: () => void; f.hold(() => new Promise(resolve => { release = resolve; }));
 const result = f.calls.load(scope); f.scope(null); release(); assert.deepEqual(await result, { kind: 'stale' }); assert.equal(f.sent.length, 1);
});
test('stale 401 does not sign out another person; current 401 does', async () => {
 const f = fixture(); let release!: () => void; f.hold(() => new Promise(resolve => { release = resolve; }));
 const result = f.calls.test(scope); f.fail({ ok: false, kind: 'unauthorised' }); f.scope({ ...scope, epoch: 'two' }); release(); await result; assert.equal(f.ended(), 0);
 f.hold(null); f.scope(scope); await f.calls.test(scope); assert.equal(f.ended(), 1);
});
test('unknown test sends are not replayed, honour Retry-After, and require refresh', async () => {
 const f = fixture(); await f.controls.refresh(); f.fail({ ok: false, kind: 'unavailable', status: 503, retryAfter: 5 }); await f.controls.test();
 await f.controls.test(); await f.controls.refresh(); assert.equal(f.sent.length, 3); assert.match(f.controls.snapshot().message, /may have completed/);
 f.time(5000); f.fail(null); await f.controls.test(); assert.equal(f.sent.length, 3); await f.controls.refresh(); assert.equal(f.sent.length, 5);
});
test('one pending write blocks all other operations', async () => {
 const f = fixture(); await f.controls.refresh(); let release!: () => void; f.hold(() => new Promise(resolve => { release = resolve; }));
 const result = f.controls.test(); await f.controls.remove(device.endpoint); await f.controls.register(); await f.controls.refresh(); assert.equal(f.sent.length, 3);
 f.hold(null); release(); await result;
});
test('failed list hides previous devices and cannot enable mutation', async () => {
 const f = fixture(); await f.controls.refresh(); f.fail({ ok: false, kind: 'unavailable', status: 0 }); await f.controls.refresh();
 assert.equal(f.controls.snapshot().data, null); assert.equal(f.controls.snapshot().phase, 'failed'); const n = f.sent.length; await f.controls.test(); assert.equal(f.sent.length, n);
});
test('delivery counts distinguish acceptance, failure, expiry and missing results', () => {
 assert.match(deliveryMessage([{ subscriptionId: device.id, state: 'gone' }]), /expired devices 1/);
 assert.match(deliveryMessage([]), /No delivery results/);
});
test('worker bounds malformed payloads, caches nothing, and refuses external/auth notification destinations', async () => {
 const handlers: Record<string, (event: any) => void> = {}, shown: any[] = [], opened: string[] = [];
 const self = { location: { origin: 'https://captain.example.test' }, addEventListener(name: string, fn: (event: any) => void) { handlers[name] = fn; }, registration: { async showNotification(...args: any[]) { shown.push(args); } }, clients: { async matchAll() { return []; }, async openWindow(url: string) { opened.push(url); } } };
 vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), { self, URL });
 assert.equal(handlers.fetch, undefined);
 let wait!: Promise<unknown>;
 handlers.push!({ data: { json() { throw new Error(); } }, waitUntil(p: Promise<unknown>) { wait = p; } }); await wait; assert.equal(shown[0][0], 'Captain');
 for (const url of ['https://evil.example/', '/auth/sign-out', '//evil.example/', 'javascript:alert(1)']) { handlers.notificationclick!({ notification: { close() {}, data: { url } }, waitUntil(p: Promise<unknown>) { wait = p; } }); await wait; assert.equal(opened.at(-1), 'https://captain.example.test/'); }
 handlers.notificationclick!({ notification: { close() {}, data: { url: '/settings/notifications' } }, waitUntil(p: Promise<unknown>) { wait = p; } }); await wait; assert.equal(opened.at(-1), 'https://captain.example.test/settings/notifications');
});
