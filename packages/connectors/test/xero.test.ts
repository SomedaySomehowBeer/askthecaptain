import assert from 'node:assert/strict';
import { test } from 'node:test';
import { XeroConnector, XeroError, xeroScopes } from '../src/xero.ts';
test('PKCE, rotation, tenant discovery/revocation and paged conditional reads use the documented wire format', async () => {
 const calls: { url: URL; init: RequestInit }[] = [];
 const client = new XeroConnector('client', 'https://api.test/connections/xero/callback', async (url, init) => {
  calls.push({ url: new URL(String(url)), init: init! });
  if (String(url).endsWith('/token')) return Response.json({ access_token: 'a', refresh_token: 'rotated', expires_in: 1800 });
  if (String(url).endsWith('/connections')) return Response.json([{ id: 'connection-id', tenantId: 'tenant-id', tenantName: 'Business' }, { id: 'other', tenantId: 'other-tenant', tenantName: 'Other' }]);
  if (init!.method === 'DELETE') return new Response(null, { status: 204 });
  return Response.json({ Contacts: [] });
 });
 const auth = new URL(client.authorizationUrl('state', 'challenge')); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.equal(auth.searchParams.get('scope'), xeroScopes.join(' '));
 await client.exchange('code', 'verifier'); const exchange = new URLSearchParams(calls[0]!.init.body as URLSearchParams);
 assert.equal(exchange.get('code_verifier'), 'verifier'); assert.equal(exchange.get('client_id'), 'client'); assert.equal(exchange.has('client_secret'), false);
 assert.equal((await client.refresh('old')).refreshToken, 'rotated'); assert.equal(new Headers(calls[1]!.init.headers).get('authorization'), `Basic ${Buffer.from('client:').toString('base64')}`);
 await client.page('access', 'tenant-id', 'Contacts', 2, '2026-09-01T00:00:00Z');
 const page = calls[2]!; assert.equal(page.url.searchParams.get('page'), '2'); assert.equal(page.url.searchParams.get('includeArchived'), 'true');
 assert.equal(new Headers(page.init.headers).get('xero-tenant-id'), 'tenant-id'); assert.equal(new Headers(page.init.headers).get('if-modified-since'), '2026-09-01T00:00:00Z');
 await client.disconnect('access', 'tenant-id'); assert.equal(calls.at(-1)!.url.pathname, '/connections/connection-id'); assert.equal(calls.at(-1)!.init.method, 'DELETE'); assert.equal(calls.some((c) => c.url.pathname.endsWith('/revocation')), false);
});
test('rate errors preserve Retry-After and never include the provider body; malformed tokens fail closed', async () => {
 const client = new XeroConnector('client', 'https://api.test/callback', async () => new Response('secret-provider-detail', { status: 429, headers: { 'retry-after': '125' } }));
 await assert.rejects(client.page('a', 'tenant', 'Invoices', 1), (e: unknown) => e instanceof XeroError && e.retryAfter === 125 && !e.message.includes('secret'));
 const missing = new XeroConnector('client', 'https://api.test/callback', async () => Response.json({ access_token: 'a', expires_in: 1800 }));
 await assert.rejects(missing.refresh('r'), XeroError);
});
