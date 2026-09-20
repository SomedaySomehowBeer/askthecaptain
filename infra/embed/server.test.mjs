import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbedServer, parseUnits, MAX_UNITS } from './server.mjs';
const token = 't'.repeat(40);
const encoder = { name: 'stub', version: '9', dimensions: 3, calls: [], async embed(units) { this.calls.push(units); return units.map((u, i) => [i, u.length, 0]); } };
async function withServer(run) {
 const lines = [];
 const server = createEmbedServer({ encoder, token, log: line => lines.push(line) });
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 const base = `http://127.0.0.1:${server.address().port}`;
 try { await run((path, init = {}) => fetch(base + path, init), lines); } finally { server.close(); }
}
test('rejects a short token at construction', () => { assert.throws(() => createEmbedServer({ encoder, token: 'short' }), /EMBED_TOKEN/); });
test('healthz names the encoder without authentication', () => withServer(async get => {
 const res = await get('/healthz'); assert.equal(res.status, 200);
 assert.deepEqual(await res.json(), { ok: true, encoder: 'stub', version: '9', dimensions: 3 });
}));
test('embed requires the bearer secret', () => withServer(async post => {
 const body = JSON.stringify({ units: ['hello'] });
 assert.equal((await post('/embed', { method: 'POST', body })).status, 401);
 assert.equal((await post('/embed', { method: 'POST', body, headers: { authorization: `Bearer ${'x'.repeat(40)}` } })).status, 401);
 assert.equal((await post('/embed', { method: 'POST', body, headers: { authorization: `Bearer ${token}` } })).status, 200);
}));
test('embed returns one vector per unit and logs counts only', () => withServer(async (post, lines) => {
 encoder.calls.length = 0;
 const res = await post('/embed', { method: 'POST', body: JSON.stringify({ units: ['Subject: secret order', 'a reply'] }), headers: { authorization: `Bearer ${token}` } });
 assert.equal(res.status, 200);
 const out = await res.json();
 assert.equal(out.encoder, 'stub'); assert.equal(out.version, '9'); assert.equal(out.dimensions, 3);
 assert.deepEqual(out.vectors, [[0, 21, 0], [1, 7, 0]]);
 assert.deepEqual(encoder.calls, [['Subject: secret order', 'a reply']]);
 assert.equal(lines.length, 1); assert.match(lines[0], /^embed units=2 ms=\d+$/); assert.doesNotMatch(lines.join(), /secret/);
}));
test('embed validates its body', () => withServer(async post => {
 const headers = { authorization: `Bearer ${token}` };
 for (const body of ['nope', '{}', '{"units":[]}', '{"units":[""]}', '{"units":[1]}', JSON.stringify({ units: ['x'.repeat(8001)] }), JSON.stringify({ units: Array(MAX_UNITS + 1).fill('a') })]) {
  const res = await post('/embed', { method: 'POST', body, headers });
  assert.equal(res.status, 400, body.slice(0, 30));
 }
 assert.equal((await post('/embed', { method: 'POST', body: JSON.stringify({ units: ['a'.repeat(7000)].concat(Array(63).fill('b'.repeat(7000))) }), headers })).status, 200);
 assert.equal((await post('/embed', { method: 'POST', body: 'x'.repeat(1048577), headers })).status, 413);
 assert.equal((await post('/other')).status, 404);
}));
test('embedding failures are reported without the text', () => withServer(async (post, lines) => {
 const failing = { ...encoder, async embed() { throw new Error('boom Subject: secret'); } };
 const server = createEmbedServer({ encoder: failing, token, log: line => lines.push(line) });
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 try {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/embed`, { method: 'POST', body: JSON.stringify({ units: ['hi'] }), headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 500); assert.deepEqual(await res.json(), { error: 'embedding failed' });
  assert.match(lines.at(-1), /^embed failed ms=\d+ Error$/);
 } finally { server.close(); }
}));
test('parseUnits accepts the limits exactly', () => {
 assert.deepEqual(parseUnits(JSON.stringify({ units: Array(MAX_UNITS).fill('a') })).units.length, MAX_UNITS);
 assert.equal(parseUnits(JSON.stringify({ units: ['a'.repeat(8000)] })).error, undefined);
});
