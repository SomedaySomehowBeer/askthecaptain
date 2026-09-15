import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { ShopifyConnector, shopifyScopes } from '@captain/connectors/shopify';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { open } from '../connections/encryption.ts';
import { ShopifyConnections } from './connections.ts';
import { ShopifySync, startShopifySchedule } from './sync.ts';
const it = databaseUrl ? test : test.skip; let db: Harness; let app: ReturnType<typeof createApp>; let makeApp: () => ReturnType<typeof createApp>; let connections: ShopifyConnections; let sync: ShopifySync;
let org: string; let user: string; let memberUser: string; let owner: string; let member: string; let outsider: string; let now = Date.now(); let conn: string;
const master = randomBytes(32); const id = (kind: string, n = 1) => `gid://shopify/${kind}/${n}`;
const product = (n = 1, tracked = true) => ({ id: id('ProductVariant', n), title: 'Can', sku: `SKU-${n}`, price: '12.34', product: { id: id('Product', n), title: `Beer ${n}`, status: 'ACTIVE' }, inventoryItem: { id: id('InventoryItem', n), tracked } });
const level = (n = 1, available = 3) => ({ updatedAt: new Date(now).toISOString(), location: { id: id('Location', n), name: `Shop ${n}` }, quantities: [{ name: 'available', quantity: available }] });
const order = (n = 1, currency = 'AUD') => ({ id: id('Order', n), name: `#${n}`, email: 'guest@example.test', customer: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', cancelledAt: null as string | null, totalPriceSet: { shopMoney: { amount: '10.10', currencyCode: currency } }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
let backfill: ReturnType<typeof order> | null = null; let products: unknown[][]; let levels: unknown[][]; let orders: ReturnType<typeof order>[][]; let orderIds: string[] | null; let fail: string; let rate: number; let exchangeCalls = 0; let tokenExtra: Record<string, unknown>; let beforeGraph: (() => Promise<void>) | undefined;
const calls: { operation: string; variables: Record<string, unknown>; shop: string }[] = []; const waits: number[] = [];
const reply = (data: unknown) => Response.json({ data, extensions: { cost: { requestedQueryCost: 10, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 900, restoreRate: 100 } } } });
const page = (pages: unknown[][], after: unknown) => { const index = after ? Number(after) : 0; return { nodes: pages[index] ?? [], pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) } }; };
const fetcher: typeof fetch = async (url, init) => {
 const u = new URL(String(url)); const body = JSON.parse(String(init!.body));
 if (u.pathname.endsWith('/access_token')) { exchangeCalls++; return Response.json({ access_token: 'provider-token', scope: shopifyScopes.join(','), ...tokenExtra }); }
 const operation = String(body.query).match(/(?:query|mutation)\s+(\w+)/)?.[1] ?? ''; const variables = body.variables ?? {};
 calls.push({ operation, variables, shop: u.hostname });
 if (operation !== 'Disconnect') { const [active] = await db.owner`select count(*)::int as n from pg_stat_activity where datname = current_database() and usename = 'app' and state = 'idle in transaction'`; assert.equal(active!.n, 0); }
 if (beforeGraph) await beforeGraph();
 if (operation === fail || `${operation}:${variables.after}` === fail) return new Response('provider secret', { status: 500 });
 if (rate === 200) { rate = 0; return Response.json({ errors: [{ extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 200, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 100 } } } }); }
 if (rate) return new Response('provider secret', { status: rate, headers: { 'retry-after': '120' } });
 if (operation === 'Products') return reply({ productVariants: page(products, variables.after) });
 if (operation === 'Levels') return reply({ inventoryItem: { inventoryLevels: page(levels, variables.after) } });
 if (operation === 'Orders') return reply({ orders: page(orders, variables.after) });
 if (operation === 'OrderIds') return reply({ orders: page([(orderIds ?? orders.flat().map((o) => o.id)).map((id) => ({ id }))], variables.after) });
 if (operation === 'Order') return reply({ order: orders.flat().find((o) => o.id === variables.id) ?? backfill });
 if (operation === 'Disconnect') return reply({ appUninstall: { app: { id: id('App') }, userErrors: [] } });
 throw new Error('unexpected provider request');
};
const actor = () => ({ userId: user, requestId: 'shopify-test' }); const root = () => `/v1/organisations/${org}/shopify`;
const request = (method: string, path: string, token = owner, body?: unknown) => app.request(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function start(shop = 'fixture.myshopify.com') {
 const response = await request('POST', `${root()}/start`, owner, { shop }); assert.equal(response.status, 200);
 const launch = new URL((await response.json() as { authorizationUrl: string }).authorizationUrl); const response2 = await app.request(launch.toString());
 assert.equal(response2.status, 302); assert.match(response2.headers.get('set-cookie')!, /HttpOnly/); assert.match(response2.headers.get('set-cookie')!, /SameSite=Lax/);
 return launch.searchParams.get('state')!;
}
function signed(state: string, shop = 'fixture.myshopify.com') { const values = { code: 'code', shop, state, timestamp: String(Math.floor(Date.now() / 1000)) }; const q = new URLSearchParams(values); q.set('hmac', createHmac('sha256', 'secret').update(Object.entries(values).sort().map(([k, v]) => `${k}=${v}`).join('&')).digest('hex')); return q; }
async function finish(state: string, shop = 'fixture.myshopify.com', cookie = state) { const r = await app.request(`/connections/shopify/callback?${signed(state, shop)}`, { headers: { cookie: `captain_shopify_state=${cookie}` } }); return new URL(r.headers.get('location')!).searchParams.get('shopify'); }
async function connect(shop = 'fixture.myshopify.com') { assert.equal(await finish(await start(shop), shop), 'connected'); conn = (await db.owner`select id from connections where organisation_id = ${org} and provider = 'shopify'`)[0]!.id; }
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase(); const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 }); const organisations = new OrganisationService(db.app);
 const users = await db.owner`insert into users (email) values ('owner@shop.test'), ('member@shop.test'), ('outsider@shop.test') returning id`; user = users[0]!.id; memberUser = users[1]!.id;
 owner = (await auth.issueSessionFor(user)).token; member = (await auth.issueSessionFor(memberUser)).token; outsider = (await auth.issueSessionFor(users[2]!.id)).token;
 org = (await organisations.create(actor(), { name: 'Shopify test', timezone: 'Australia/Perth' })).id; await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${memberUser}, 'member')`;
 connections = new ShopifyConnections(db.app, new ShopifyConnector('client', 'secret', 'https://api.test/connections/shopify/callback', fetcher), master, 'https://app.test');
 sync = new ShopifySync(connections, () => now, async (ms) => { waits.push(ms); now += ms; });
 makeApp = () => createApp({ db: db.app, auth, organisations, commitments: new CommitmentsService(db.app), shopifyConnections: connections, shopifySync: sync, shopifyScheduleEnabled: true });
});
beforeEach(async () => {
 if (!db) return; app = makeApp(); backfill = null; now = Date.now(); products = [[product()]]; levels = [[level()]]; orders = [[order()]]; orderIds = null; fail = ''; rate = 0; tokenExtra = {}; beforeGraph = undefined; calls.length = 0; waits.length = 0;
 await db.owner`delete from shopify_products`; await db.owner`delete from shopify_orders`; await db.owner`delete from sync_cursors where resource like 'shopify.%'`;
 await connect();
});
after(async () => { await db?.close(); });
it('members read and set thresholds; only owner/admin manage; outsiders see nothing', async () => {
 assert.equal((await request('GET', `${root()}/connection`, '')).status, 401);
 assert.equal((await request('GET', `${root()}/connection`, member)).status, 200);
 for (const [method, path, body] of [['POST', '/start', { shop: 'fixture.myshopify.com' }], ['POST', '/sync', undefined], ['DELETE', '/connection', undefined]] as const) assert.equal((await request(method, root() + path, member, body)).status, 403);
 for (const path of ['/connection', '/stock', '/summary']) assert.equal((await request('GET', root() + path, outsider)).status, 404);
 await sync.run(org); const item = (await db.owner`select id from shopify_products`)[0]!.id;
 assert.equal((await request('PATCH', `${root()}/stock/${item}`, member, { reorderPoint: '4.50' })).status, 200);
 assert.equal((await request('PATCH', `${root()}/stock/${item}`, outsider, { reorderPoint: 9 })).status, 404);
 assert.equal((await request('PATCH', `${root()}/stock/${item}`, member, { reorderPoint: 4, available: 500 })).status, 400);
 const data = await (await request('GET', `${root()}/stock?belowReorder=true`, member)).json() as { items: { available: number; reorderPoint: string }[] }; assert.equal(data.items[0]!.available, 3); assert.equal(data.items[0]!.reorderPoint, '4.50');
});
it('callback binds shop, state, browser, expiry and current role; one-use tokens are encrypted and never returned', async () => {
 const state = await start(); const before = exchangeCalls;
 assert.equal(await finish(state, 'fixture.myshopify.com', 'wrong'), 'failed'); assert.equal(exchangeCalls, before);
 assert.equal(await finish(state, 'other.myshopify.com'), 'failed'); assert.equal(exchangeCalls, before);
 const expired = await start();
 await db.owner`update auth_requests set expires_at = now() - interval '1 minute' where kind = 'shopify_connection' and consumed_at is null`;
 assert.equal(await finish(expired), 'failed');
 const revoked = await start(); await db.owner`update memberships set role = 'member' where organisation_id = ${org} and user_id = ${user}`; assert.equal(await finish(revoked), 'failed'); await db.owner`update memberships set role = 'owner' where organisation_id = ${org} and user_id = ${user}`;
 const valid = await start(); assert.equal(await finish(valid), 'connected'); assert.equal(await finish(valid), 'failed');
 const [row] = await db.owner`select access_token_encrypted, refresh_token_encrypted, access_token_expires_at from connections where id = ${conn}`; const [organisation] = await db.owner`select data_key_wrapped from organisations where id = ${org}`;
 const key = open(master, organisation!.dataKeyWrapped, org, 'data_key'); assert.equal(open(key, row!.accessTokenEncrypted, org, 'access_token').toString(), 'provider-token'); assert.equal(row!.refreshTokenEncrypted, null); assert.equal(row!.accessTokenExpiresAt, null);
 const status = await (await request('GET', `${root()}/connection`)).text(); assert.doesNotMatch(status, /provider-token|accessTokenEncrypted|master/);
 tokenExtra = { expires_in: 3600 }; assert.equal(await finish(await start()), 'failed');
});
it('pages products and each inventory location, preserves thresholds and removes deleted records after completion', async () => {
 products = [[product()], [{ ...product(2, false), product: { ...product(2).product, status: 'UNLISTED' } }]]; levels = [[level(1, 0)], [level(2, -2)]];
 await sync.run(org); assert.equal((await db.owner`select * from shopify_products`).length, 2); assert.equal((await db.owner`select * from shopify_inventory_levels`).length, 2);
 const item = (await db.owner`select id from shopify_products where provider_id = ${id('ProductVariant')}`)[0]!.id;
 await request('PATCH', `${root()}/stock/${item}`, member, { reorderPoint: 5 }); await connect(); await sync.run(org); assert.equal((await db.owner`select * from shopify_reorder_points`).length, 1);
 products = [[product(2, false)]]; orders = [[]]; await sync.run(org); assert.equal((await db.owner`select * from shopify_inventory_levels`).length, 0); assert.equal((await db.owner`select * from shopify_reorder_points`).length, 0); assert.equal((await db.owner`select * from shopify_orders`).length, 0);
 const data = await (await request('GET', `${root()}/stock`)).json() as { items: { available: number | null; belowReorder: boolean | null }[] }; assert.equal(data.items[0]!.available, null); assert.equal(data.items[0]!.belowReorder, null);
});
it('incremental order cursor advances only after reconciliation; failures remain visibly incomplete', async () => {
 await sync.run(org); const [previous] = await db.owner`select cursor from sync_cursors where connection_id = ${conn} and resource = 'shopify.orders'`;
 now += 5000; fail = 'OrderIds'; orders = [[{ ...order(), displayFulfillmentStatus: 'FULFILLED' }]]; await assert.rejects(sync.run(org), { status: 503 });
 assert.equal((await db.owner`select cursor from sync_cursors where connection_id = ${conn} and resource = 'shopify.orders'`)[0]!.cursor, previous!.cursor);
 const status = await connections.status(actor(), org); assert.equal(status.complete, false); assert.ok(status.lastSyncedAt); assert.doesNotMatch(status.error!, /provider secret/);
 assert.ok(calls.filter((c) => c.operation === 'Orders').at(-1)!.variables.query?.toString().includes('updated_at:>='));
 fail = ''; await sync.run(org); assert.equal((await connections.status(actor(), org)).complete, true);
});
it('partial product snapshots never delete existing variants, and long rate limits survive another run', async () => {
 products = [[product(), product(2)]]; await sync.run(org); products = [[product()], [product(3)]]; fail = 'Products:1';
 await assert.rejects(sync.run(org)); assert.equal((await db.owner`select * from shopify_products`).length, 2);
 fail = ''; rate = 429; await assert.rejects(sync.run(org), { status: 503 }); const called = calls.length;
 rate = 0; await assert.rejects(sync.run(org), { status: 503 }); assert.equal(calls.length, called);
 now += 121_000; await sync.run(org); assert.equal((await connections.status(actor(), org)).complete, true);
});
it('a replaced grant or expired lease fences old pages; sync never writes with another run’s lease', async () => {
 let once = true; beforeGraph = async () => { if (once) { once = false; await db.owner`update sync_cursors set cursor = 'new-run' where resource = 'shopify.sync-lock' and connection_id = ${conn}`; } };
 await assert.rejects(sync.run(org), { status: 409 }); assert.equal((await db.owner`select * from shopify_products`).length, 0);
 assert.equal((await db.owner`select cursor from sync_cursors where resource = 'shopify.sync-lock' and connection_id = ${conn}`)[0]!.cursor, 'new-run');
 await db.owner`delete from sync_cursors where resource = 'shopify.sync-lock'`; beforeGraph = undefined;
 let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let entered!: () => void; const waiting = new Promise<void>((resolve) => { entered = resolve; });
 beforeGraph = async () => { entered(); await gate; }; const running = sync.run(org); await waiting; await assert.rejects(sync.run(org), { status: 409 }); release(); await running;
});
it('summary separates currencies, uses organisation dates, excludes cancellations and labels the order window', async () => {
 const [clock] = await db.owner`select (current_timestamp at time zone 'Australia/Perth')::date::text as today`;
 const stamp = `${clock!.today}T00:05:00+08:00`; now = Date.parse(stamp);
 orders = [[{ ...order(1), createdAt: stamp }, { ...order(2), createdAt: stamp, displayFulfillmentStatus: 'FULFILLED' }, { ...order(3, 'USD'), createdAt: stamp, displayFulfillmentStatus: 'PARTIALLY_FULFILLED' }, { ...order(4), cancelledAt: stamp }]];
 await sync.run(org); const result = await (await request('GET', `${root()}/summary`, member)).json() as { ordersToday: number; unfulfilled: number; coverage: string; totals: { currency: string; totalToday: string }[] };
 assert.equal(result.ordersToday, 3); assert.equal(result.unfulfilled, 2); assert.equal(result.totals[0]!.totalToday, '20.20'); assert.equal(result.totals[1]!.currency, 'USD'); assert.match(result.coverage, /60 days/);
});
it('disconnect clears local access despite provider failure; switching shops clears the old shop cache', async () => {
 await sync.run(org); await connect('other.myshopify.com'); assert.equal((await db.owner`select * from shopify_products`).length, 0); assert.equal((await db.owner`select * from shopify_orders`).length, 0);
 await assert.rejects(connections.accessToken(org, conn, 'fixture.myshopify.com'));
 fail = 'Disconnect'; assert.equal((await request('DELETE', `${root()}/connection`)).status, 200);
 const [row] = await db.owner`select status, access_token_encrypted, error from connections where id = ${conn}`; assert.equal(row!.status, 'disconnected'); assert.equal(row!.accessTokenEncrypted, null); assert.match(row!.error, /Remove Captain/);
 assert.deepEqual(await sync.organisations(), []);
});
it('scheduled sync discovers ids, honours disabled mode and does not overlap itself', async () => {
 assert.deepEqual(await sync.organisations(), [org]); let runs = 0; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
 const routine = { organisations: async () => [org], run: async () => { runs++; await gate; return { products: 0, levels: 0, orders: 0 }; } }; const disabled = startShopifySchedule(routine, true, 5); await disabled(); assert.equal(runs, 0);
 const stop = startShopifySchedule(routine, false, 5); await new Promise((r) => setTimeout(r, 25)); assert.equal(runs, 1); release(); await stop();
});

it('GraphQL throttles retry with a wait; paged orders reconcile new identities and reject mismatched backfills', async () => {
 rate = 200; orders = [[order(1)], [order(2)]]; backfill = order(3); orderIds = [id('Order', 1), id('Order', 2), id('Order', 3)];
 await sync.run(org); assert.ok(waits.includes(2000)); assert.equal((await db.owner`select * from shopify_orders`).length, 3);
 assert.ok(calls.some((c) => c.operation === 'Orders' && c.variables.after === '1')); assert.ok(calls.some((c) => c.operation === 'Order'));
 const previous = (await db.owner`select cursor from sync_cursors where resource = 'shopify.orders'`)[0]!.cursor;
 orderIds = [id('Order', 4)]; backfill = order(5); await assert.rejects(sync.run(org), { status: 503 });
 assert.equal((await db.owner`select cursor from sync_cursors where resource = 'shopify.orders'`)[0]!.cursor, previous);
 assert.equal((await db.owner`select * from shopify_orders`).length, 3);
});
