import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { httpEmbedClient, EmbedUnavailable } from '../src/index.ts';
async function serve(handler: (req: { method: string; path: string; auth: string; body: string }) => { status: number; body: unknown }) {
	const server = createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { const out = handler({ method: req.method!, path: req.url!, auth: String(req.headers.authorization ?? ''), body }); res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body)); }); });
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}
test('the client sends the bearer secret, reads the encoder identity once, and returns vectors', async () => {
	const seen: string[] = [];
	const s = await serve((req) => { seen.push(`${req.method} ${req.path}`);
		if (req.path === '/healthz') return { status: 200, body: { ok: true, encoder: 'e', version: '1', dimensions: 2 } };
		assert.equal(req.auth, 'Bearer ' + 's'.repeat(40)); const units = JSON.parse(req.body).units as string[];
		return { status: 200, body: { encoder: 'e', version: '1', dimensions: 2, vectors: units.map((u) => [u.length, 0]) } }; });
	try {
		const client = httpEmbedClient(s.url, 's'.repeat(40));
		assert.deepEqual(await client.identity(), { encoder: 'e', version: '1', dimensions: 2 }); await client.identity();
		assert.deepEqual((await client.embed(['ab', 'abc'])).vectors, [[2, 0], [3, 0]]);
		assert.deepEqual((await client.embed([])).vectors, []);
		assert.deepEqual(seen, ['GET /healthz', 'POST /embed']);
		await assert.rejects(client.embed(Array(65).fill('a')), RangeError);
	} finally { s.close(); }
});
test('failures are EmbedUnavailable and never carry the text', async () => {
	const s = await serve((req) => req.path === '/healthz' ? { status: 200, body: { ok: true, encoder: 'e', version: '1', dimensions: 2 } } : { status: 503, body: { error: 'down' } });
	try {
		const client = httpEmbedClient(s.url, 's'.repeat(40));
		await assert.rejects(client.embed(['Subject: secret']), (error: unknown) => error instanceof EmbedUnavailable && error.status === 503 && !error.message.includes('secret'));
	} finally { s.close(); }
	const gone = httpEmbedClient('http://127.0.0.1:9', 's'.repeat(40));
	await assert.rejects(gone.embed(['x']), (error: unknown) => error instanceof EmbedUnavailable && error.status === null);
	const odd = await serve(() => ({ status: 200, body: { nope: true } }));
	try { await assert.rejects(httpEmbedClient(odd.url, 's'.repeat(40)).identity(), EmbedUnavailable); } finally { odd.close(); }
});
