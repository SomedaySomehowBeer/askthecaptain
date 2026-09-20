// The embedding service (D21): stateless, shared by every organisation, holds no data. Text arrives
// over TLS with a bearer secret, is embedded in memory and never written or logged.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const MAX_UNITS = 64;
export const MAX_UNIT_CHARS = 8000;
export const MAX_BODY_BYTES = 1048576;
const send = (res, status, body) => { const text = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text); };
const sameToken = (given, expected) => { const a = Buffer.from(String(given ?? '')), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b); };
// Validates the request body: 1..64 non-empty strings of at most 8000 characters each.
export function parseUnits(body) {
 let parsed;
 try { parsed = JSON.parse(body); } catch { return { error: 'body is not JSON' }; }
 const units = parsed?.units;
 if (!Array.isArray(units) || units.length === 0) return { error: 'units must be a non-empty array' };
 if (units.length > MAX_UNITS) return { error: `at most ${MAX_UNITS} units per request` };
 for (const unit of units) {
  if (typeof unit !== 'string' || unit.trim().length === 0) return { error: 'each unit is a non-empty string' };
  if (unit.length > MAX_UNIT_CHARS) return { error: `each unit is at most ${MAX_UNIT_CHARS} characters` };
 }
 return { units };
}
function readBody(req) {
 return new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  // Past the limit the rest of the body is discarded, not kept, and the caller gets a 413.
  req.on('data', chunk => { size += chunk.length; if (size > MAX_BODY_BYTES) { chunks.length = 0; req.removeAllListeners('data'); req.resume(); reject(Object.assign(new Error('too large'), { status: 413 })); } else chunks.push(chunk); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
 });
}
// `encoder` is { name, version, dimensions, embed(units) }; `log` receives one line per request with
// counts and timings only. Requests are embedded one at a time so memory stays bounded on one CPU.
export function createEmbedServer({ encoder, token, log = console.log }) {
 if (!token || token.length < 32) throw new Error('EMBED_TOKEN must be at least 32 characters');
 let queue = Promise.resolve();
 const serial = work => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
 return createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://embed');
  try {
   if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, encoder: encoder.name, version: encoder.version, dimensions: encoder.dimensions });
   if (req.method !== 'POST' || url.pathname !== '/embed') return send(res, 404, { error: 'not found' });
   const auth = req.headers.authorization ?? '';
   if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) return send(res, 401, { error: 'unauthorised' });
   const { units, error } = parseUnits(await readBody(req));
   if (error) return send(res, 400, { error });
   const vectors = await serial(() => encoder.embed(units));
   send(res, 200, { encoder: encoder.name, version: encoder.version, dimensions: encoder.dimensions, vectors });
   log(`embed units=${units.length} ms=${Date.now() - started}`);
  } catch (error) {
   if (res.headersSent) return;
   if (error?.status === 413) { res.setHeader('connection', 'close'); return send(res, 413, { error: 'body too large' }); }
   log(`embed failed ms=${Date.now() - started} ${error?.constructor?.name ?? 'Error'}`);
   send(res, 500, { error: 'embedding failed' });
  }
 });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
 const { loadEncoder } = await import('./model.mjs');
 const encoder = await loadEncoder(process.env.MODEL_DIR ?? './models');
 await encoder.embed(['warm up']);
 const port = Number(process.env.PORT ?? 8080);
 createEmbedServer({ encoder, token: process.env.EMBED_TOKEN }).listen(port, '0.0.0.0', () => console.log(`embed ${encoder.name} v${encoder.version} listening on ${port}`));
}
