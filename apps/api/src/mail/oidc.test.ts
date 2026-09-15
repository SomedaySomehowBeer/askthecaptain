import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { GooglePushVerifier } from './oidc.ts';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }); const next = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
const audience = 'https://api.test/webhooks/gmail'; const email = 'gmail-pubsub@project-test.iam.gserviceaccount.com';
const now = 1_800_000_000_000;
function token(claims: object = {}, header: object = {}, key = pair.privateKey) {
 const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'one', ...header })).toString('base64url');
 const p = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: audience, email, email_verified: true, sub: '12345', iat: now / 1000, exp: now / 1000 + 3600, ...claims })).toString('base64url');
 return `Bearer ${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url')}`;
}
test('Google push validates signature, issuer, audience, service identity, verified email, times and algorithm', async () => {
 const verifier = new GooglePushVerifier(audience, email, async () => Response.json({ one: pem }, { headers: { 'cache-control': 'public, max-age=3600' } }), () => now);
 await verifier.verify(token()); await verifier.verify(token({ iss: 'accounts.google.com' }));
 for (const claims of [{ iss: 'https://evil.test' }, { aud: 'elsewhere' }, { email: 'other@project-test.iam.gserviceaccount.com' }, { email_verified: false }, { email_verified: 'true' }, { exp: now / 1000 }, { iat: now / 1000 + 61 }, { exp: now / 1000 + 8000 }]) await assert.rejects(verifier.verify(token(claims)), { status: 401 });
 for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unknown' }, { crit: ['unsupported'] }]) await assert.rejects(verifier.verify(token({}, header)), { status: 401 });
 await assert.rejects(verifier.verify(token({}, {}, next.privateKey)), { status: 401 });
 for (const raw of [undefined, 'Bearer garbage', 'Bearer e30.e30.x', 'Bearer ' + 'x'.repeat(20000)]) await assert.rejects(verifier.verify(raw), { status: 401 });
});
test('certificates are cached, refresh on expiry/rotation, and concurrent refreshes coalesce', async () => {
 let time = now; let calls = 0; let rotate = false;
 const verifier = new GooglePushVerifier(audience, email, async (input) => {
  assert.equal(String(input), 'https://www.googleapis.com/oauth2/v1/certs'); calls++;
  return Response.json(rotate ? { two: next.publicKey.export({ type: 'spki', format: 'pem' }) } : { one: pem }, { headers: { 'cache-control': 'public, max-age=60', age: '10' } });
 }, () => time);
 await Promise.all([verifier.verify(token()), verifier.verify(token())]); assert.equal(calls, 1);
 await assert.rejects(verifier.verify(token({}, { kid: 'unknown' })), { status: 401 }); assert.equal(calls, 1);
 time += 50_001; await verifier.verify(token()); assert.equal(calls, 2);
 rotate = true; time += 30_001; await verifier.verify(token({}, { kid: 'two' }, next.privateKey)); assert.equal(calls, 3);
});
test('certificate outages fail closed with a retryable status', async () => {
 const verifier = new GooglePushVerifier(audience, email, async () => new Response('unavailable', { status: 503 }), () => now);
 await assert.rejects(verifier.verify(token()), { status: 503 });
});
