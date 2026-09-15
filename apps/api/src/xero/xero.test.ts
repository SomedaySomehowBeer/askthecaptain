import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { XeroConnector, xeroScopes } from '@captain/connectors/xero';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { open } from '../connections/encryption.ts';
import { XeroConnections } from './connections.ts';
import { XeroSync, startXeroSchedule } from './sync.ts';
const it = databaseUrl ? test : test.skip; let db: Harness; let app: ReturnType<typeof createApp>; let connections: XeroConnections; let sync: XeroSync;
let org: string; let user: string; let memberUser: string; let owner: string; let member: string; let outsider: string;
const master = randomBytes(32); let exchangeCalls = 0; let refreshCalls = 0; let refreshFails = false; let missingScopes = false; let now = Date.now();
let contactPages: unknown[][] = []; let invoicePages: unknown[][] = []; let paymentPages: unknown[][] = []; let failPage = ''; let rate = false;
let beforePage: (() => Promise<void>) | undefined; const calls: { path: string; since: string | null; tenant: string | null }[] = [];
const stamp = '/Date(1789430400000+0000)/';
const contact = (id = 'c1') => ({ ContactID: id, Name: 'Exact Company', EmailAddress: 'PERSON@example.test', IsCustomer: true, IsSupplier: false, Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '123' }], UpdatedDateUTC: stamp });
const invoice = (id = 'i1', type = 'ACCREC', currency = 'AUD') => ({ InvoiceID: id, Type: type, Contact: { ContactID: 'c1' }, InvoiceNumber: id, Status: 'AUTHORISED', Date: '/Date(1704067200000)/', DueDate: '/Date(1704153600000)/', CurrencyCode: currency, Total: '100.10', AmountDue: '90.10', AmountPaid: '10.00', UpdatedDateUTC: stamp });
const fetcher: typeof fetch = async (input, init) => {
 const url = new URL(String(input));
 if (url.pathname.endsWith('/token')) {
  const params = new URLSearchParams(init!.body as URLSearchParams);
  if (params.get('grant_type') === 'refresh_token') { refreshCalls++; if (refreshFails) return Response.json({ error: 'secret error' }, { status: 400 }); await new Promise((r) => setTimeout(r, 20)); return Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 1800 }); }
  exchangeCalls++; return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 1800, scope: (missingScopes ? ['offline_access'] : xeroScopes).join(' ') });
 }
 if (url.pathname === '/connections') return Response.json([{ id: 'grant-a', tenantId: 'tenant-a', tenantName: 'Xero A' }, { id: 'grant-b', tenantId: 'tenant-b', tenantName: 'Xero B' }]);
 if (init?.method === 'DELETE') { assert.equal(url.pathname, '/connections/grant-a'); return new Response(null, { status: 204 }); }
 calls.push({ path: url.pathname, since: new Headers(init?.headers).get('if-modified-since'), tenant: new Headers(init?.headers).get('xero-tenant-id') });
 // Accounting network calls must not hold a tenant transaction open.
 const [active] = await db.owner`select count(*)::int as n from pg_stat_activity where datname = current_database() and usename = 'app' and state = 'idle in transaction'`; assert.equal(active!.n, 0);
 if (beforePage) await beforePage();
 const resource = url.pathname.split('/')[3]!; const page = Number(url.searchParams.get('page') ?? 1);
 if (rate) return new Response('provider secret', { status: 429, headers: { 'retry-after': '120' } });
 if (`${resource}:${page}` === failPage) return new Response('provider secret', { status: 500 });
 if (url.pathname.endsWith('/Contacts/missing-contact')) return Response.json({ Contacts: [{ ...contact('missing-contact'), EmailAddress: '' }] });
 if (url.pathname.endsWith('/Invoices/missing-invoice')) return Response.json({ Invoices: [{ ...invoice('missing-invoice'), Contact: { ContactID: 'missing-contact' } }] });
 return Response.json({ [resource]: ({ Contacts: contactPages, Invoices: invoicePages, Payments: paymentPages }[resource] ?? [])[page - 1] ?? [] });
};
const actor = () => ({ userId: user, requestId: 'xero-test' });
const root = () => `/v1/organisations/${org}/xero`;
const request = (method: string, path: string, token = owner, body?: unknown) => app.request(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const stored = async () => (await db.owner`select * from connections where organisation_id = ${org} and provider = 'xero'`)[0]!;
async function start() { const r = await request('POST', `${root()}/start`); assert.equal(r.status, 200); return new URL((await r.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state')!; }
async function finish(state: string) { const r = await app.request(`/connections/xero/callback?state=${state}&code=code`); return new URL(r.headers.get('location')!).searchParams.get('xero'); }
async function connect(tenant = 'tenant-a') { assert.equal(await finish(await start()), 'select'); const status = await connections.status(actor(), org); await connections.select(actor(), org, status.selection!.id, tenant); return (await stored()).id as string; }
before(async () => {
 if (!databaseUrl) return; db = await freshDatabase();
 const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 }); const organisations = new OrganisationService(db.app);
 const users = await db.owner`insert into users (email) values ('owner@test.com'), ('member@test.com'), ('outsider@test.com') returning id`;
 user = users[0]!.id; memberUser = users[1]!.id;
 owner = (await auth.issueSessionFor(user)).token; member = (await auth.issueSessionFor(memberUser)).token; outsider = (await auth.issueSessionFor(users[2]!.id)).token;
 org = (await organisations.create(actor(), { name: 'Xero test', timezone: 'Australia/Perth' })).id;
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${memberUser}, 'member')`;
 connections = new XeroConnections(db.app, new XeroConnector('client', 'https://api.test/connections/xero/callback', fetcher), master, 'https://app.test');
 sync = new XeroSync(connections, () => now, async (ms) => { now += ms; });
 app = createApp({ db: db.app, auth, organisations, commitments: new CommitmentsService(db.app), xeroConnections: connections, xeroSync: sync, xeroScheduleEnabled: true });
});
after(async () => { await db?.close(); });
it('members read; only owner/admin can connect, select, sync or disconnect; outsiders cannot read money', async () => {
 assert.equal((await request('GET', `${root()}/connection`, '')).status, 401);
 assert.equal((await request('GET', `${root()}/connection`, member)).status, 200);
 for (const [method, path, body] of [['POST', '/start', undefined], ['DELETE', '/connection', undefined], ['POST', '/sync', undefined], ['POST', '/select', { selectionId: org, tenantId: 'tenant-a' }]] as const) assert.equal((await request(method, root() + path, member, body)).status, 403);
 for (const path of ['/connection', '/summary', '/receivables']) assert.equal((await request('GET', root() + path, outsider)).status, 404);
 assert.equal((await request('GET', `${root()}/receivables?overdueDays=-1`)).status, 400);
});
it('state is single-use and bound to a current manager; pending selection is encrypted, expires, and restricts tenant ids', async () => {
 const state = await start(); assert.equal(await finish(state), 'select'); assert.equal(await finish(state), 'failed');
 const status = await connections.status(actor(), org); const selection = status.selection!;
 const [pending] = await db.owner`select payload from auth_requests where id = ${selection.id}`; assert.equal(JSON.stringify(pending).includes('access-secret'), false); assert.equal(JSON.stringify(status).includes('encrypted'), false);
 await assert.rejects(connections.select(actor(), org, selection.id, 'not-authorised'), { code: 'invalid_tenant' });
 await assert.rejects(connections.select({ userId: memberUser, requestId: 'test' }, org, selection.id, 'tenant-a'), { code: 'forbidden' });
 await db.owner`update auth_requests set expires_at = now() - interval '1 minute' where id = ${selection.id}`;
 await assert.rejects(connections.select(actor(), org, selection.id, 'tenant-a'), { code: 'selection_expired' });
 const changed = await start(); const exchanges = exchangeCalls; await db.owner`update memberships set role = 'member' where organisation_id = ${org} and user_id = ${user}`;
 assert.equal(await finish(changed), 'failed'); assert.equal(exchangeCalls, exchanges); await db.owner`update memberships set role = 'owner' where organisation_id = ${org} and user_id = ${user}`;
 missingScopes = true; assert.equal(await finish(await start()), 'failed'); missingScopes = false;
 const expired = await start(); await db.owner`update auth_requests set expires_at = now() - interval '1 minute' where kind = 'xero_connection' and consumed_at is null`; assert.equal(await finish(expired), 'failed');
 const wrong = await start(); await db.owner`update auth_requests set kind = 'oauth' where kind = 'xero_connection' and consumed_at is null`; assert.equal(await finish(wrong), 'failed');
});
it('connection selection encrypts tokens; concurrent system refresh rotates once; failure commits an honest state', async () => {
 const id = await connect(); const row = await stored(); assert.equal(row.accountEmail, null); assert.equal(row.providerAccountId, 'tenant-a');
 const [o] = await db.owner`select data_key_wrapped from organisations where id = ${org}`; const key = open(master, o!.dataKeyWrapped, org, 'data_key');
 assert.equal(open(key, row.refreshTokenEncrypted, org, 'refresh_token').toString(), 'refresh-secret');
 await db.owner`update connections set access_token_expires_at = now() where id = ${id}`;
 assert.deepEqual(await Promise.all([connections.accessToken(undefined, org, id), connections.accessToken(undefined, org, id)]), ['new-access', 'new-access']); assert.equal(refreshCalls, 1);
 assert.equal(open(key, (await stored()).refreshTokenEncrypted, org, 'refresh_token').toString(), 'rotated-refresh');
 assert.equal(await connections.accessToken({ userId: memberUser, requestId: 'test' }, org, id), 'new-access');
 const [journal] = await db.owner`select actor_kind from audit_events where action = 'xero.refreshed'`; assert.equal(journal!.actorKind, 'system');
 refreshFails = true; await db.owner`update connections set access_token_expires_at = now() where id = ${id}`;
 await assert.rejects(connections.accessToken(undefined, org, id), { code: 'xero_refresh_failed' }); assert.equal((await stored()).status, 'refresh_failed'); refreshFails = false;
 await connections.accessToken(undefined, org, id); assert.equal((await stored()).status, 'connected');
});
it('paged sync caches exact money, backfills references, maps exact matches, preserves hand edits and serves member reads', async () => {
 await db.owner`insert into companies (organisation_id, name, notes) values (${org}, 'Exact Company', 'Hand note')`;
 await db.owner`insert into contacts (organisation_id, email, name, phone, source, notes) values (${org}, 'person@example.test', 'Hand Name', 'hand-phone', 'hand', 'hand-note')`;
 contactPages = [Array.from({ length: 100 }, (_, i) => ({ ...contact(`c${i}`), EmailAddress: i === 1 ? 'PERSON@example.test' : '' })), [contact('c100')]];
 invoicePages = [[invoice(), invoice('payable', 'ACCPAY'), invoice('usd', 'ACCREC', 'USD'), { ...invoice('draft'), Status: 'DRAFT' }, { ...invoice('paid'), Status: 'PAID', AmountDue: '0', FullyPaidOnDate: stamp }]];
 paymentPages = [[{ PaymentID: 'p1', Invoice: { InvoiceID: 'i1' }, Date: stamp, Amount: '10', Status: 'AUTHORISED' }, { PaymentID: 'p2', Invoice: { InvoiceID: 'missing-invoice' }, Date: stamp, Amount: '1', Status: 'AUTHORISED' }, { PaymentID: 'other', Date: stamp, Amount: '2', Status: 'AUTHORISED' }]];
 const counts = await sync.run(org); assert.equal(counts.contacts, 102); assert.equal(counts.invoices, 6); assert.equal(counts.skippedPayments, 1); assert.ok(calls.every((c) => c.tenant === 'tenant-a'));
 const [person] = await db.owner`select * from contacts where email = 'person@example.test'`; assert.equal(person!.name, 'Hand Name'); assert.equal(person!.phone, 'hand-phone'); assert.equal(person!.notes, 'hand-note'); assert.equal(person!.companyId, null);
 const [company] = await db.owner`select * from companies`; assert.equal(company!.notes, 'Hand note'); assert.ok(company!.externalRefs['xero:tenant-a']);
 const [matched] = await db.owner`select contact_id from xero_contacts where provider_id = 'c1'`; assert.equal(matched!.contactId, person!.id);
 const summary = await (await request('GET', `${root()}/summary`, member)).json() as { complete: boolean; totals: { currency: string; overdueReceivables: string; overduePayables: string }[] };
 assert.equal(summary.complete, true); const aud = summary.totals.find((r) => r.currency === 'AUD')!; assert.equal(aud.overdueReceivables, '180.20'); assert.equal(aud.overduePayables, '90.10'); assert.equal(summary.totals.length, 2);
 const received = await (await request('GET', `${root()}/receivables?overdueDays=5`, member)).json() as { invoices: { contactName: string; amountDue: string }[] }; assert.equal(received.invoices.length, 3); assert.equal(received.invoices[0]!.amountDue, '90.10');
 invoicePages = [[{ ...invoice(), AmountDue: '80.10', AmountPaid: '20' }]]; paymentPages = [[{ PaymentID: 'p1', Status: 'DELETED' }]]; contactPages = [[]]; calls.length = 0;
 await sync.run(org); assert.ok(calls.filter((c) => /\/(Contacts|Invoices|Payments)$/.test(c.path)).every((c) => c.since === new Date(now - 60_000).toISOString()));
 assert.equal((await db.owner`select * from xero_payments where provider_id = 'p1'`).length, 0);
});
it('due-this-week uses local dates; overdue thresholds exclude today, paid and voided invoices', async () => {
 const [dates] = await db.owner`select (current_timestamp at time zone 'Australia/Perth')::date::text as today,
  ((current_timestamp at time zone 'Australia/Perth')::date - 1)::text as yesterday,
  (date_trunc('week', current_timestamp at time zone 'Australia/Perth') + interval '1 week')::date::text as next_monday`;
 invoicePages = [[{ ...invoice('today'), DueDate: dates!.today, AmountDue: '0.20' }, { ...invoice('yesterday'), DueDate: dates!.yesterday, AmountDue: '0.10' },
  { ...invoice('next-week'), DueDate: dates!.nextMonday, AmountDue: '999' }, { ...invoice('voided'), Status: 'VOIDED', DueDate: dates!.yesterday }]];
 await sync.run(org);
 const summary = await (await request('GET', `${root()}/summary`, member)).json() as { asOfDate: string; totals: { currency: string; dueThisWeek: string }[] };
 assert.equal(summary.asOfDate, dates!.today); assert.equal(summary.totals.find((t) => t.currency === 'AUD')!.dueThisWeek, '0.20');
 const get = async (days: number) => (await (await request('GET', `${root()}/receivables?overdueDays=${days}`)).json() as { invoices: { providerId: string }[] }).invoices.map((i) => i.providerId);
 assert.ok((await get(1)).includes('yesterday')); assert.equal((await get(2)).includes('yesterday'), false);
 for (const id of ['today', 'voided', 'paid', 'draft', 'next-week']) assert.equal((await get(0)).includes(id), false);
});
it('partial pages remain replayable, do not advance the resource cursor, and mark money incomplete', async () => {
 const [prior] = await db.owner`select cursor from sync_cursors where resource = 'xero.contacts'`;
 contactPages = [Array.from({ length: 100 }, (_, i) => contact(`partial-${i}`)), [contact('final')]]; failPage = 'Contacts:2';
 await assert.rejects(sync.run(org), { code: 'xero_sync_failed' }); const [after] = await db.owner`select cursor from sync_cursors where resource = 'xero.contacts'`; assert.equal(after!.cursor, prior!.cursor);
 assert.equal((await connections.status(actor(), org)).complete, false); assert.equal((await db.owner`select * from xero_contacts where provider_id like 'partial-%'`).length, 100);
 failPage = ''; await sync.run(org); assert.equal((await connections.status(actor(), org)).complete, true); assert.equal((await db.owner`select * from xero_contacts where provider_id like 'partial-%'`).length, 100);
});
it('persisted 429 backoff survives a new runner; minute and daily call budgets gate requests', async () => {
 contactPages = [[]]; invoicePages = [[]]; paymentPages = [[]]; rate = true; await assert.rejects(sync.run(org), /rate limit/); rate = false;
 const n = calls.length; await assert.rejects(new XeroSync(connections, () => now).run(org), /rate limit/); assert.equal(calls.length, n);
 now += 120_001; await sync.run(org);
 const id = (await stored()).id;
 await db.owner`update sync_cursors set cursor = ${JSON.stringify({ calls: Array(60).fill(now), retryAt: 0 })} where connection_id = ${id} and resource = 'xero.rate:tenant-a'`;
 const start = now; await sync.run(org); assert.ok(now >= start + 60_000);
 await db.owner`update sync_cursors set cursor = ${JSON.stringify({ calls: Array(5000).fill(now - 120_000), retryAt: 0 })} where connection_id = ${id} and resource = 'xero.rate:tenant-a'`;
 const before = calls.length; await assert.rejects(sync.run(org), /rate limit/); assert.equal(calls.length, before);
 await db.owner`delete from sync_cursors where resource like 'xero.rate:%'`;
});
it('competing runs are excluded; a replaced account fences old writes and clears old caches', async () => {
 let release!: () => void; let entered!: () => void; const waiting = new Promise<void>((r) => { entered = r; }); const gate = new Promise<void>((r) => { release = r; });
 beforePage = async () => { entered(); await gate; }; contactPages = [[contact('stale')]];
 const running = sync.run(org); const rejected = assert.rejects(running, { code: 'xero_sync_running' }); await waiting;
 await assert.rejects(new XeroSync(connections).run(org), { code: 'xero_sync_running' });
 const id = await connect('tenant-b'); release(); await rejected; beforePage = undefined;
 assert.equal((await stored()).id, id); assert.equal((await db.owner`select * from xero_contacts`).length, 0); assert.equal((await connections.status(actor(), org)).lastSyncedAt, null);
 await connect(); await connections.disconnect(actor(), org); assert.equal((await stored()).status, 'disconnected'); assert.equal((await stored()).refreshTokenEncrypted, null);
 const summary = await (await request('GET', `${root()}/summary`, member)).json() as { totals: unknown; complete: boolean }; assert.equal(summary.totals, null); assert.equal(summary.complete, false);
 const journals = await db.owner`select detail from audit_events where action like 'xero.%'`; assert.equal(JSON.stringify(journals).includes('access-secret'), false); assert.equal(JSON.stringify(journals).includes('provider secret'), false);
});
it('the 15-minute scheduler can be disabled and drains its active run', async () => {
 let runs = 0; const worker = { organisations: async () => [org], run: async () => { runs++; return {}; } };
 await startXeroSchedule(worker as never, true)(); assert.equal(runs, 0);
 await startXeroSchedule(worker as never, false)(); assert.equal(runs, 1);
});
