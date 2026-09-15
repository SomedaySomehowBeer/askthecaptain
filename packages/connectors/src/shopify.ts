import { createHmac, timingSafeEqual } from 'node:crypto';
export const shopifyVersion = '2026-07';
export const shopifyScopes = ['read_products', 'read_inventory', 'read_orders', 'read_customers'];
export function shopDomain(value: string): string {
 const shop = value.trim().toLowerCase();
 if (!/^[a-z0-9][a-z0-9-]{0,61}\.myshopify\.com$/.test(shop)) throw new ShopifyError(400);
 return shop;
}
export class ShopifyError extends Error {
 readonly status: number; readonly retryAfter: number;
 constructor(status = 502, retryAfter = 60) { super('Shopify request failed'); this.status = status; this.retryAfter = retryAfter; }
}
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ShopifyError(); return v as Record<string, unknown>; };
export type GraphReply = { data: Record<string, unknown>; delayMs: number };
export const productFields = 'id title sku price product { id title status } inventoryItem { id tracked }';
export const orderFields = 'id name email customer { displayName email } displayFinancialStatus displayFulfillmentStatus cancelledAt totalPriceSet { shopMoney { amount currencyCode } } createdAt updatedAt';
const pageInfo = 'pageInfo { hasNextPage endCursor }';
export const queries = {
 products: `query Products($after: String) { productVariants(first: 50, after: $after) { nodes { ${productFields} } ${pageInfo} } }`,
 levels: `query Levels($id: ID!, $after: String) { inventoryItem(id: $id) { inventoryLevels(first: 100, after: $after) { nodes { updatedAt location { id name } quantities(names: ["available"]) { name quantity } } ${pageInfo} } } }`,
 orders: `query Orders($after: String, $query: String!) { orders(first: 100, after: $after, query: $query, sortKey: UPDATED_AT) { nodes { ${orderFields} } ${pageInfo} } }`,
 orderIds: `query OrderIds($after: String, $query: String!) { orders(first: 100, after: $after, query: $query, sortKey: CREATED_AT) { nodes { id } ${pageInfo} } }`,
 order: `query Order($id: ID!) { order(id: $id) { ${orderFields} } }`
};
/** Standalone custom-distribution OAuth; no online/expiring token is accepted by this seam. */
export class ShopifyConnector {
 readonly clientId: string; readonly redirectUri: string; private readonly secret: string; private readonly fetcher: typeof fetch;
 constructor(clientId: string, secret: string, redirectUri: string, fetcher: typeof fetch = fetch) { this.clientId = clientId; this.secret = secret; this.redirectUri = redirectUri; this.fetcher = fetcher; }
 authorizationUrl(shop: string, state: string) {
  const url = new URL(`https://${shopDomain(shop)}/admin/oauth/authorize`);
  url.search = new URLSearchParams({ client_id: this.clientId, scope: shopifyScopes.join(','), redirect_uri: this.redirectUri, state }).toString(); return url.toString();
 }
 verifyCallback(query: URLSearchParams, cookie: string | undefined, now = Date.now()) {
  const state = query.get('state'); const hmac = query.get('hmac'); const timestamp = query.get('timestamp');
  if (!state || !cookie || state.length !== cookie.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie)) || !hmac || !/^[a-f0-9]{64}$/.test(hmac) || !timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 900) throw new ShopifyError(400);
  if (new Set(query.keys()).size !== [...query.keys()].length) throw new ShopifyError(400);
  const message = [...query].filter(([key]) => key !== 'hmac').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('&');
  if (!timingSafeEqual(createHmac('sha256', this.secret).update(message).digest(), Buffer.from(hmac, 'hex'))) throw new ShopifyError(400);
  return { shop: shopDomain(query.get('shop') ?? ''), state, code: query.get('code') ?? '' };
 }
 async exchange(shop: string, code: string) {
  const r = object(await (await this.request(`https://${shopDomain(shop)}/admin/oauth/access_token`, { method: 'POST', body: JSON.stringify({ client_id: this.clientId, client_secret: this.secret, code, expiring: 0 }) })).json());
  if (typeof r.access_token !== 'string' || !r.access_token || typeof r.scope !== 'string' || r.expires_in !== undefined || r.associated_user !== undefined || r.refresh_token !== undefined) throw new ShopifyError();
  const scopes = r.scope.split(','); if (!shopifyScopes.every((s) => scopes.includes(s))) throw new ShopifyError(403);
  return { accessToken: r.access_token, scopes };
 }
 async graphql(shop: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<GraphReply> {
  const r = object(await (await this.request(`https://${shopDomain(shop)}/admin/api/${shopifyVersion}/graphql.json`, { method: 'POST', headers: { 'x-shopify-access-token': token }, body: JSON.stringify({ query, variables }) })).json());
  let delayMs = 1000;
  if (r.extensions) {
   const cost = object(object(r.extensions).cost); const status = object(cost.throttleStatus);
   const { currentlyAvailable: available, restoreRate: rate, maximumAvailable: maximum } = status; const requested = cost.requestedQueryCost;
   if (![available, rate, maximum, requested].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) || !rate || !maximum) throw new ShopifyError();
   // Reserve enough budget for the next query, allowing a larger query after a small one.
   delayMs = Math.ceil(Math.max(0, Math.min(maximum as number, Math.max(200, requested as number)) - (available as number)) / (rate as number) * 1000);
  }
  if (Array.isArray(r.errors) && r.errors.length) {
   const throttled = r.errors.some((e) => object(e).extensions && object(object(e).extensions).code === 'THROTTLED');
   throw new ShopifyError(throttled ? 429 : 502, Math.max(1, Math.ceil(delayMs / 1000)));
  }
  return { data: object(r.data), delayMs };
 }
 async disconnect(shop: string, token: string) {
  const r = await this.graphql(shop, token, 'mutation Disconnect { appUninstall { app { id } userErrors { field message } } }');
  const result = object(r.data.appUninstall);
  if (!Array.isArray(result.userErrors) || result.userErrors.length || !result.app) throw new ShopifyError();
 }
 private async request(url: string, init: RequestInit) {
  let response: Response;
  try { response = await this.fetcher(url, { ...init, headers: { accept: 'application/json', 'content-type': 'application/json', ...init.headers }, redirect: 'error', signal: AbortSignal.timeout(15_000) }); } catch { throw new ShopifyError(); }
  if (!response.ok) { const retry = response.headers.get('retry-after'); const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? (Date.parse(retry) - Date.now()) / 1000 : 60; throw new ShopifyError(response.status, Number.isFinite(seconds) ? Math.max(1, seconds) : 60); }
  return response;
 }
}
