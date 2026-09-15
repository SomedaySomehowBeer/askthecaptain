import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { ShopifyConnector, ShopifyError, shopDomain, shopifyScopes, shopifyVersion } from '../src/shopify.ts';
const signed = (values: Record<string, string>) => { const q = new URLSearchParams(values); q.set('hmac', createHmac('sha256', 'secret').update(Object.entries(values).sort().map(([k, v]) => `${k}=${v}`).join('&')).digest('hex')); return q; };
test('OAuth validates host, HMAC, nonce, duplicates and expiry before using the callback', () => {
 const client = new ShopifyConnector('client', 'secret', 'https://api.test/connections/shopify/callback');
 assert.equal(shopDomain(' MY-SHOP.myshopify.com '), 'my-shop.myshopify.com');
 for (const shop of ['https://a.myshopify.com', 'a.myshopify.com.evil.test', 'a.myshopify.com/path', 'a.myshopify.com:443', 'a@b.myshopify.com', '127.0.0.1', 'a..myshopify.com']) assert.throws(() => shopDomain(shop));
 const url = new URL(client.authorizationUrl('a.myshopify.com', 'nonce')); assert.equal(url.searchParams.get('scope'), shopifyScopes.join(',')); assert.equal(url.searchParams.has('grant_options[]'), false);
 const q = signed({ code: 'code&value', shop: 'a.myshopify.com', state: 'nonce', timestamp: String(Math.floor(Date.now() / 1000)), host: 'base64==' });
 assert.equal(client.verifyCallback(q, 'nonce').code, 'code&value');
 assert.throws(() => client.verifyCallback(q, undefined)); assert.throws(() => client.verifyCallback(q, 'other')); assert.throws(() => client.verifyCallback(q, 'nonce', Date.now() + 901_000));
 const duplicate = new URLSearchParams(q); duplicate.append('shop', 'b.myshopify.com'); assert.throws(() => client.verifyCallback(duplicate, 'nonce'));
 q.set('code', 'tampered'); assert.throws(() => client.verifyCallback(q, 'nonce'));
});
test('offline exchange rejects expiring, online and incomplete grants; requests never follow redirects', async () => {
 let extra: Record<string, unknown> = {}; let call = 0;
 const client = new ShopifyConnector('client', 'secret', 'https://api.test/callback', async (url, init) => {
  call++; assert.equal(String(url), 'https://a.myshopify.com/admin/oauth/access_token'); assert.equal(init!.redirect, 'error');
  const body = JSON.parse(String(init!.body)); assert.equal(body.expiring, 0); assert.equal(body.client_secret, 'secret');
  return Response.json({ access_token: 'fixture-token', scope: shopifyScopes.join(','), ...extra });
 });
 assert.equal((await client.exchange('a.myshopify.com', 'code')).accessToken, 'fixture-token');
 for (const invalid of [{ expires_in: 3600 }, { refresh_token: 'refresh' }, { associated_user: {} }, { scope: 'read_products' }]) { extra = invalid; await assert.rejects(client.exchange('a.myshopify.com', 'code'), ShopifyError); }
 const before = call; await assert.rejects(client.exchange('evil.test', 'code')); assert.equal(call, before);
});
test('GraphQL detects HTTP-200 errors, respects cost restoration, pins version and sanitises provider failures', async () => {
 let errors: unknown[] = []; let http = 200;
 const client = new ShopifyConnector('client', 'secret', 'https://api.test/callback', async (url, init) => {
  assert.equal(String(url), `https://a.myshopify.com/admin/api/${shopifyVersion}/graphql.json`); assert.equal(new Headers(init!.headers).get('x-shopify-access-token'), 'token');
  return Response.json({ data: { shop: { name: 'Fixture' } }, errors, extensions: { cost: { requestedQueryCost: 100, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 } } } }, { status: http, headers: { 'retry-after': '120' } });
 });
 assert.equal((await client.graphql('a.myshopify.com', 'token', 'query { shop { name } }')).delayMs, 4000);
 errors = [{ message: 'provider secret', extensions: { code: 'THROTTLED' } }]; await assert.rejects(client.graphql('a.myshopify.com', 'token', 'query'), { status: 429, retryAfter: 4, message: 'Shopify request failed' });
 errors = [{ message: 'provider secret' }]; await assert.rejects(client.graphql('a.myshopify.com', 'token', 'query'), { status: 502 });
 http = 429; await assert.rejects(client.graphql('a.myshopify.com', 'token', 'query'), { status: 429, retryAfter: 120 });
});
