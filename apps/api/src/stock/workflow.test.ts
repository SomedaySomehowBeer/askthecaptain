import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { withTenant } from '@captain/db';
import { databaseUrl, freshDatabase, type Harness } from '@captain/db/test';
import { BossEngine, type HandlerContext } from '@captain/engine';
import { definitions } from '@captain/steps';
import { stocktakeFixture } from '../../test/stocktake-fixture.ts';
import { until } from '../../test/workflow-fixture.ts';
import { createApp } from '../app.ts';
import { AuthService } from '../auth/service.ts';
import { OrganisationService } from '../organisations/service.ts';
import { CommitmentsService } from '../commitments/service.ts';
import { StockService } from './service.ts';
const it = databaseUrl ? test : test.skip; let db: Harness;
before(async () => { if (databaseUrl) db = await freshDatabase(); }); after(async () => { await db?.close(); });
type Fixture = Awaited<ReturnType<typeof stocktakeFixture>>;
const state = (f: Fixture, id: string, wanted: string) => until(() => f.tx(tx => tx`select state, reason from workflow_runs where id = ${id}`), rows => rows[0]?.state === wanted);
async function supplier(f: Fixture, emails: string[] = ['orders@supplier.test']) {
 const [company] = await f.tx(tx => tx`insert into companies (organisation_id, name) values (${f.org}, 'Malt supplier') returning id`);
 for (const email of emails) await f.tx(tx => tx`insert into contacts (organisation_id, company_id, name, email, source) values (${f.org}, ${company!.id}, 'Supplier', ${email}, 'hand')`);
 return String(company!.id);
}
const item = (f: Fixture, name = 'Malt', extra = {}) => f.stock.save(f.actor, f.org, { name, location: 'Store', unitLabel: 'bags', reorderPoint: '5', ...extra });
it('real runner wakes from a member’s HTTP count, reorders only below threshold in the enabling person’s name without mail or inference', async () => {
 const f = await stocktakeFixture(db); try {
  assert.deepEqual(f.registry.missing(definitions.find(d => d.key === 'stocktake')!), []);
  const a = await item(f, 'A malt', { preferredSupplierId: await supplier(f) }); const b = await item(f, 'B cans'); await item(f, 'Elsewhere', { location: 'Cold room' });
  const archived = await item(f, 'Archived'); await f.stock.save(f.actor, f.org, { archived: true }, archived.id);
  await f.stock.count(f.member, f.org, a.id, { count: '1' }); // Before the run: cannot satisfy its wait.
  const auth = new AuthService(db.app, null, { appUrl: 'https://app.test', sessionTtlDays: 1 });
  const app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments: new CommitmentsService(db.app), stock: f.stock, workflows: f.workflows });
  const owner = (await auth.issueSessionFor(f.userId)).token, member = (await auth.issueSessionFor(f.member.userId)).token, outsider = (await auth.issueSessionFor(f.stranger.userId)).token;
  const request = (path: string, token: string, body: unknown) => app.request(`/v1/organisations/${f.org}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request('workflows/stocktake/run', member, {})).status, 403); assert.equal((await request('workflows/stocktake/run', outsider, {})).status, 404);
  assert.equal((await request('workflows/stocktake/run', owner, { parameters: { nonsense: true } })).status, 400);
  const response = await request('workflows/stocktake/run', owner, { parameters: { location: 'Store' } }); assert.equal(response.status, 202); const { runId } = await response.json() as { runId: string };
  await state(f, runId, 'waiting'); assert.equal(f.pushes.length, 1); assert.equal(f.pushes[0]!.tag, `stock:${a.id}`); assert.equal(f.pushes[0]!.url, '/resources/inventory#stock');
  assert.equal((await request(`stock/${a.id}/count`, member, { count: '2.5' })).status, 201);
  await until(() => f.tx(tx => tx`select wait_key from workflow_run_steps where run_id = ${runId} and state = 'waiting'`), rows => rows.some(r => r.waitKey === `stock:${b.id}`));
  await f.stock.count(f.member, f.org, b.id, { count: '8' }); await state(f, runId, 'succeeded');
  assert.equal((await f.tx(tx => tx`select * from outbox`)).length, 0);
  assert.equal((await f.tx(tx => tx`select * from model_usage`)).length, 0);
  const tasks = await f.tx(tx => tx`select * from tasks`); assert.equal(tasks.length, 1); assert.equal(tasks[0]!.title, 'Reorder A malt (2.5 bags left, reorder at 5)'); assert.equal(tasks[0]!.createdBy, f.userId); assert.equal(tasks[0]!.sourceId, runId);
  const [due] = await f.tx(tx => tx`select (current_timestamp at time zone timezone)::date + 7 as due from organisations where id = ${f.org}`); assert.equal(String(tasks[0]!.due), String(due!.due));
  assert.equal((await f.tx(tx => tx`select * from stock_counts`)).length, 3); assert.equal(f.pushes.length, 2);
  const observed = await f.tx(tx => tx`select detail from audit_events where action = 'stock.count_observed'`); assert.equal(observed.length, 2); assert.equal(observed[0]!.detail.countedBy, f.member.userId);
  assert.match(JSON.stringify(await f.tx(tx => tx`select output from workflow_run_steps where run_id = ${runId}`)), /Shopify is not connected/);
 } finally { await f.engine.close(); }
});
it('Supplier addresses are irrelevant; observations and tasks are idempotent receipts', async () => {
 const f = await stocktakeFixture(db); try {
  const a = await item(f, 'Malt', { preferredSupplierId: await supplier(f, ['one@supplier.test', 'two@supplier.test']) }); const { runId } = await f.startStocktake(); await state(f, runId, 'waiting');
  await f.stock.count(f.member, f.org, a.id, { count: '0' }); await state(f, runId, 'succeeded');
  const steps = await f.tx(tx => tx`select path, key, output from workflow_run_steps where run_id = ${runId}`);
  const stockItem = steps.find(s => s.key === 'stock.items')!.output[0], count = steps.find(s => s.key === 'stock.counted')!.output;
  const [run] = await f.tx(tx => tx`select enablement_id from workflow_runs where id = ${runId}`);
  for (const key of ['stock.recordCount', 'tasks.createInProject']) {
   const step = steps.find(s => s.key === key)!;
   const context: HandlerContext = { organisationId: f.org, userId: f.userId, runId, enablementId: run!.enablementId, path: step.path, itemIndex: 0, idempotencyKey: JSON.stringify([f.org, runId, step.path, 0]), step: { kind: 'write', key } };
   const handler = f.registry.get(context.step); assert.ok('transaction' in handler);
   await f.tx(tx => handler.transaction({ ...context, tx }, { item: stockItem, count, project: 'Purchasing' }));
  }
  assert.equal((await f.tx(tx => tx`select * from stock_counts`)).length, 1); assert.equal((await f.tx(tx => tx`select * from tasks`)).length, 1);
  assert.equal((await f.tx(tx => tx`select * from audit_events where action = 'stock.count_observed'`)).length, 1);
 } finally { await f.engine.close(); }
});
it('a count racing wait registration wakes it; count and wake roll back together', async () => {
 const f = await stocktakeFixture(db); let release!: () => void; try {
  const a = await item(f); const original = f.registry.handlers.get('stock.counted')!; assert.ok('transaction' in original);
  const gate = new Promise<void>(r => { release = r; }); let entered!: () => void; const atWait = new Promise<void>(r => { entered = r; }); let first = true;
  f.registry.handlers.set('stock.counted', { kind: 'await', transaction: async (ctx, args) => { const value = await original.transaction(ctx, args); if (first) { first = false; entered(); await gate; } return value as { ready: boolean; key: string }; } });
  const { runId } = await f.startStocktake(); await atWait;
  const counting = f.stock.count(f.member, f.org, a.id, { count: '9' }); await new Promise(r => setTimeout(r, 100)); release(); await counting; await state(f, runId, 'succeeded');
  const broken = new StockService(db.app, async () => { throw Error('queue failed'); }); await assert.rejects(broken.count(f.member, f.org, a.id, { count: '1' }));
  assert.equal((await f.tx(tx => tx`select count from stock_counts`)).length, 1); assert.equal((await f.stock.list(f.actor, f.org)).items[0]!.currentCount, '9');
 } finally { release?.(); await f.engine.close(); }
});
it('count events remain queued while workers are stopped and a restarted runner resumes the wait', async () => {
 const f = await stocktakeFixture(db); let restarted: BossEngine | undefined; try {
  const a = await item(f); const { runId } = await f.startStocktake(); await state(f, runId, 'waiting'); await f.engine.close();
  await f.stock.count(f.member, f.org, a.id, { count: '7' });
  restarted = new BossEngine(db.app, db.runtimeUrl, f.registry, definitions); await restarted.open();
  await state(f, runId, 'succeeded'); assert.equal((await f.tx(tx => tx`select * from stock_counts`)).length, 1);
 } finally { await restarted?.close(); await f.engine.close(); }
});
it('Shopify creates reorder tasks without counting; incomplete sync is journaled and skipped', async () => {
 const f = await stocktakeFixture(db); try {
  const [conn] = await f.tx(tx => tx`insert into connections (organisation_id, connected_by, provider, provider_account_id, status, scopes) values (${f.org}, ${f.userId}, 'shopify', 'fixture.myshopify.com', 'connected', '{read_products,read_inventory}') returning id`);
  const run = randomUUID(); const gid = (kind: string, n = 1) => `gid://shopify/${kind}/${n}`;
  for (const n of [1, 2]) await f.tx(async tx => {
   await tx`insert into shopify_products (organisation_id, connection_id, provider_id, product_provider_id, title, variant_title, price, product_status, inventory_item_id, tracked, seen_run)
    values (${f.org}, ${conn!.id}, ${gid('ProductVariant', n)}, ${gid('Product', n)}, ${'Beer ' + n}, 'Default Title', 5, 'ACTIVE', ${gid('InventoryItem', n)}, true, ${run})`;
   await tx`insert into shopify_inventory_levels (organisation_id, connection_id, inventory_item_id, location_provider_id, location_name, available, updated_at, seen_run)
    values (${f.org}, ${conn!.id}, ${gid('InventoryItem', n)}, ${gid('Location')}, 'Shop', ${n === 1 ? 2 : 8}, now(), ${run})`;
   await tx`insert into shopify_reorder_points (organisation_id, connection_id, variant_provider_id, reorder_point) values (${f.org}, ${conn!.id}, ${gid('ProductVariant', n)}, 5)`;
  });
  await f.tx(tx => tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${f.org}, ${conn!.id}, 'shopify.state', ${JSON.stringify({ complete: true, error: null, lastSyncedAt: new Date().toISOString(), coverageSince: null })})`);
  const first = await f.startStocktake('Empty'); await state(f, first.runId, 'succeeded');
  const tasks = await f.tx(tx => tx`select title from tasks`); assert.equal(tasks.length, 1); assert.equal(tasks[0]!.title, 'Reorder Beer 1 (2 units left, reorder at 5)'); assert.equal(f.pushes.length, 0); assert.equal((await f.tx(tx => tx`select * from stock_counts`)).length, 0);
  await f.tx(tx => tx`delete from sync_cursors where connection_id = ${conn!.id}`);
  const second = await f.startStocktake('Empty'); await state(f, second.runId, 'succeeded'); assert.equal((await f.tx(tx => tx`select * from tasks`)).length, 1);
  assert.match(JSON.stringify(await f.tx(tx => tx`select output from workflow_run_steps where run_id = ${second.runId}`)), /sync is incomplete/);
  assert.equal((await f.tx(tx => tx`select parameters from workflow_enablements where definition_key = 'stocktake'`))[0]!.parameters.location, 'Store');
 } finally { await f.engine.close(); }
});
it('cross-tenant counts cannot wake or reorder another organisation; removed enablers pause writes', async () => {
 const f = await stocktakeFixture(db); try {
  const a = await item(f); const { runId } = await f.startStocktake(); await state(f, runId, 'waiting');
  const [other] = await db.owner`insert into organisations (name) values ('Other') returning id`;
  await db.owner`insert into memberships (organisation_id, user_id, role) values (${other!.id}, ${f.member.userId}, 'member')`;
  await withTenant(db.app, { organisationId: other!.id, userId: f.member.userId }, tx => f.engine.emit(tx, other!.id, 'stock.counted', { itemId: a.id }, `stock:${a.id}`));
  assert.equal((await f.tx(tx => tx`select state from workflow_runs where id = ${runId}`))[0]!.state, 'waiting');
  await assert.rejects(f.stock.count(f.member, other!.id, a.id, { count: '1' }), { status: 404 });
  await f.tx(tx => tx`update memberships set status = 'removed' where user_id = ${f.userId}`);
  await f.stock.count(f.member, f.org, a.id, { count: '1' }); await state(f, runId, 'paused'); assert.equal((await f.tx(tx => tx`select * from tasks`)).length, 0);
 } finally { await f.engine.close(); }
});
it('ambiguous Purchasing projects pause safely and resume once repaired; oversize locations are never truncated', async () => {
 const f = await stocktakeFixture(db); try {
  const a = await item(f); const projects = await f.tx(tx => tx`insert into projects (organisation_id, name) values (${f.org}, 'Purchasing'), (${f.org}, 'Purchasing') returning id`);
  const { runId } = await f.startStocktake(); await state(f, runId, 'waiting'); await f.stock.count(f.member, f.org, a.id, { count: '1' });
  const paused = await state(f, runId, 'paused'); assert.match(paused[0]!.reason, /distinct names/); assert.equal((await f.tx(tx => tx`select * from tasks`)).length, 0);
  await f.tx(tx => tx`update projects set name = 'Other work' where id = ${projects[1]!.id}`); await f.workflows.control(f.actor, f.org, runId, 'resume'); await state(f, runId, 'succeeded');
  await f.tx(tx => tx`insert into stock_items (organisation_id, name, location, unit_label) select ${f.org}, 'Extra ' || n, 'Store', 'bags' from generate_series(1, 100) n`);
  const oversized = await f.startStocktake(); const result = await state(f, oversized.runId, 'paused'); assert.match(result[0]!.reason, /100 items/);
 } finally { await f.engine.close(); }
});
it('a count after the persisted three-day deadline stays saved but cannot satisfy the expired wait', async () => {
 const f = await stocktakeFixture(db); try {
  const a = await item(f); const { runId } = await f.startStocktake(); await state(f, runId, 'waiting');
  const [deadline] = await f.tx(tx => tx`select deadline > now() + interval '2 days' as three_days from workflow_run_steps where run_id = ${runId} and key = 'stock.counted'`); assert.equal(deadline!.threeDays, true);
  await f.tx(tx => tx`update workflow_run_steps set deadline = now() - interval '1 second' where run_id = ${runId} and key = 'stock.counted'`);
  await f.stock.count(f.member, f.org, a.id, { count: '1' }); const ended = await state(f, runId, 'failed'); assert.match(ended[0]!.reason, /wait timed out/);
  assert.equal((await f.tx(tx => tx`select * from stock_counts`)).length, 1); assert.equal((await f.tx(tx => tx`select * from tasks`)).length, 0);
 } finally { await f.engine.close(); }
});
