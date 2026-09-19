import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SpritesClient, SpritesError, spriteFiles } from './sprites.ts';

const calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
const fake = (answers: Record<string, [number, unknown]>): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
	const url = String(input); const key = `${init?.method} ${new URL(url).pathname}`;
	const body = init?.body == null ? null : typeof init.body === 'string' ? init.body : Buffer.from(init.body as Uint8Array).toString();
	calls.push({ method: init?.method ?? 'GET', url, headers: init?.headers as Record<string, string>, body });
	const [status, data] = answers[key] ?? [500, { error: 'unexpected ' + key }];
	return new Response(data === null ? null : JSON.stringify(data), { status });
}) as typeof fetch;

test('provision creates, uploads the files under 0600, starts the service, makes the URL public and returns the URL', async () => {
	calls.length = 0;
	const client = new SpritesClient('org/tok/secret', fake({
		'POST /v1/sprites': [201, { name: 'captain-x' }], 'PUT /v1/sprites/captain-x/fs/write': [200, null], 'PUT /v1/sprites/captain-x/services/inference': [200, {}],
		'POST /v1/sprites/captain-x/services/inference/stop': [404, { error: 'not running' }], 'POST /v1/sprites/captain-x/services/inference/start': [200, null], 'PUT /v1/sprites/captain-x': [200, {}], 'GET /v1/sprites/captain-x': [200, { url: 'https://captain-x.sprites.app', primary_region: 'syd' }]
	}));
	const files = await spriteFiles('claude', 'a'.repeat(64));
	assert.deepEqual(Object.keys(files).sort(), ['bootstrap.sh', 'catalog.mjs', 'codex.toml', 'login.py', 'runtime.json', 'shim.mjs']);
	assert.deepEqual(await client.provision('captain-x', files), { url: 'https://captain-x.sprites.app/', region: 'syd' });
	assert.ok(calls.every((c) => c.headers.authorization === 'Bearer org/tok/secret'));
	const writes = calls.filter((c) => c.url.includes('/fs/write'));
	assert.equal(writes.length, 6);
	for (const w of writes) { const q = new URL(w.url).searchParams; assert.equal(q.get('mode'), '0600'); assert.equal(q.get('mkdirParents'), 'true'); assert.ok(q.get('path')!.startsWith('/home/sprite/captain-setup/')); }
	assert.ok(writes.find((w) => w.url.includes('runtime.json'))!.body!.includes('"provider":"claude"'));
	const service = JSON.parse(calls.find((c) => c.url.endsWith('/services/inference'))!.body!);
	assert.deepEqual(service, { name: 'inference', cmd: 'bash', args: ['/home/sprite/captain-setup/bootstrap.sh'], needs: [], http_port: 8080 });
	assert.deepEqual(JSON.parse(calls.find((c) => c.method === 'PUT' && c.url.endsWith('/v1/sprites/captain-x'))!.body!), { url_settings: { auth: 'public' } });
	assert.deepEqual(calls.map((c) => c.method), ['POST', 'PUT', 'PUT', 'PUT', 'PUT', 'PUT', 'PUT', 'PUT', 'POST', 'POST', 'PUT', 'GET']);
	assert.deepEqual(JSON.parse(calls[0]!.body!), { name: 'captain-x' });
});

test('an existing Sprite is reused, a failure names the operation and status but no body, and destroy tolerates 404', async () => {
	calls.length = 0;
	const client = new SpritesClient('t', fake({ 'POST /v1/sprites': [409, { error: 'exists' }], 'PUT /v1/sprites/captain-x/fs/write': [500, { error: 'PRIVATE-DETAIL', message: 'private words' }] }));
	await assert.rejects(client.provision('captain-x', { 'shim.mjs': Buffer.from('x') }), (e: unknown) => e instanceof SpritesError && e.op === 'write shim.mjs' && e.status === 500 && e.reason === null && !e.message.includes('PRIVATE') && !e.message.includes('private words'));
	const forbidden = new SpritesClient('t', fake({ 'POST /v1/sprites': [403, { error: 'org_not_enabled', message: 'Contact support about org ACME' }] }));
	await assert.rejects(forbidden.provision('captain-x', {}), (e: unknown) => e instanceof SpritesError && e.status === 403 && e.reason === 'org_not_enabled' && !e.message.includes('ACME'));
	const sentence = new SpritesClient('t', fake({ 'POST /v1/sprites': [403, { error: 'restricted tokens cannot set labels' }] }));
	await assert.rejects(sentence.provision('captain-x', {}), (e: unknown) => e instanceof SpritesError && e.reason === 'restricted_tokens_cannot_set_labels');
	const named = new SpritesClient('t', fake({ 'POST /v1/sprites': [403, { error: 'Org ACME (id 42) is suspended.' }] }));
	await assert.rejects(named.provision('captain-x', {}), (e: unknown) => e instanceof SpritesError && e.reason === null);
	await assert.rejects(client.provision('Bad Name', {}), (e: unknown) => e instanceof SpritesError && e.op === 'create');
	const gone = new SpritesClient('t', fake({ 'DELETE /v1/sprites/captain-x': [404, null] }));
	await gone.destroy('captain-x');
});
