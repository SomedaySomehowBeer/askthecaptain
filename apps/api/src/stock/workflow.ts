import { withTenant, type Sql } from '@captain/db';
import { Registry, type HandlerContext } from '@captain/engine';
import { draftOrderEmailInstruction } from '@captain/steps';
import { z } from 'zod';
import type { InferenceService } from '../inference/service.ts';
import type { PushService } from '../push/service.ts';
import { inferenceStep } from '../workflows/bindings.ts';
import { draftSchema, journal, type Context } from '../triage/data.ts';
import { workflowDraft } from '../triage/outbox.ts';
import { shopifyState } from '../shopify/connections.ts';
const quantity = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const itemSchema = z.object({ id: z.uuid(), name: z.string(), location: z.string(), unitLabel: z.string(), reorderPoint: quantity.nullable(),
 preferredSupplier: z.object({ name: z.string(), email: z.string().nullable() }).nullable(), count: quantity.nullable().optional(), belowReorderPoint: z.boolean().nullable().optional() });
const countSchema = z.object({ countId: z.uuid(), count: quantity, belowReorderPoint: z.boolean(), countedBy: z.uuid().nullable(), countedAt: z.iso.datetime() });
const problem = (code: string) => Object.assign(Error('Stocktake needs attention'), { code });
async function receipt(ctx: Context, action: string) {
 await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${ctx.idempotencyKey}, 0))`;
 return (await ctx.tx`select subject_id, detail from audit_events where action = ${action} and detail->>'idempotencyKey' = ${ctx.idempotencyKey} limit 1`)[0];
}
export class StocktakeService {
 readonly db: Sql; readonly inference: InferenceService; readonly push: PushService;
 constructor(db: Sql, inference: InferenceService, push: PushService) { this.db = db; this.inference = inference; this.push = push; }
 async items(ctx: Context, args: Record<string, unknown>) {
  const location = z.string().trim().min(1).max(200).parse(args.location);
  const rows = await ctx.tx`select s.id, s.name, s.location, s.unit_label, s.reorder_point::text, c.name as supplier_name,
   (select case when count(*) = 1 then min(email) else null end from contacts where company_id = c.id and archived_at is null) as supplier_email
   from stock_items s left join companies c on c.organisation_id = s.organisation_id and c.id = s.preferred_supplier_id and c.archived_at is null
   where s.archived_at is null and s.location = ${location} order by s.name, s.id limit 101`;
  if (rows.length > 100) throw problem('stocktake_limit');
  return rows.map(r => itemSchema.parse({ ...r, preferredSupplier: r.supplierName ? { name: r.supplierName, email: z.email().safeParse(r.supplierEmail).success ? r.supplierEmail : null } : null }));
 }
 async counted(ctx: Context, args: Record<string, unknown>) {
  const item = itemSchema.parse(args.item);
  const [row] = await ctx.tx`select c.id as count_id, c.count::text, c.counted_by, c.counted_at,
   coalesce(c.count < ${item.reorderPoint}::numeric, false) as below_reorder_point
   from stock_counts c join workflow_runs r on r.id = ${ctx.runId}
   left join workflow_run_steps w on w.run_id = r.id and w.path = ${ctx.path}
   where (w.deadline is null or c.counted_at <= w.deadline) and c.item_id = ${item.id} and c.counted_at > r.started_at order by c.counted_at desc, c.id desc limit 1`;
  return { ready: Boolean(row), key: `stock:${item.id}`, ...(row ? { output: countSchema.parse({ ...row, countedAt: row.countedAt.toISOString() }) } : {}) };
 }
 async record(ctx: Context, args: Record<string, unknown>) {
  const item = itemSchema.parse(args.item), count = countSchema.parse(args.count);
  const [saved] = await ctx.tx`select c.id from stock_counts c join workflow_runs r on r.id = ${ctx.runId}
   where c.id = ${count.countId} and c.item_id = ${item.id} and c.count = ${count.count}::numeric and c.counted_at > r.started_at`;
  if (!saved) throw problem('stocktake_count');
  if (!await receipt(ctx, 'stock.count_observed')) await journal(ctx, 'stock.count_observed', 'stock_item', item.id, { ...count, idempotencyKey: ctx.idempotencyKey });
  return count;
 }
 async task(ctx: Context, args: Record<string, unknown>) {
  const item = itemSchema.parse(args.item), count = args.count ? countSchema.parse(args.count).count : item.count;
  const projectName = z.string().trim().min(1).max(80).parse(args.project);
  if (count === undefined || count === null || item.reorderPoint === null) throw problem('stocktake_count');
  const previous = await receipt(ctx, 'stock.reorder_task_created'); if (previous) return { id: previous.subjectId };
  await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${ctx.organisationId + ':stocktake-project:' + projectName}, 0))`;
  const matches = await ctx.tx`select id from projects where name = ${projectName} and archived_at is null order by id limit 2 for share`;
  if (matches.length > 1) throw problem('stocktake_project');
  let projectId = matches[0]?.id;
  if (!projectId) {
   const [project] = await ctx.tx`insert into projects (organisation_id, name, created_by) values (${ctx.organisationId}, ${projectName}, ${ctx.userId}) returning id`;
   projectId = project!.id; await journal(ctx, 'project.created', 'project', projectId);
  }
  const title = `Reorder ${item.name} (${count} ${item.unitLabel} left, reorder at ${item.reorderPoint})`;
  const [task] = await ctx.tx`insert into tasks (organisation_id, project_id, title, body, due, source_kind, source_id, created_by)
   values (${ctx.organisationId}, ${projectId}, ${title}, ${'Stocktake at ' + item.location + '. Review the quantity to order; this task does not place an order.'},
   (select (current_timestamp at time zone timezone)::date + 7 from organisations where id = ${ctx.organisationId}), 'run', ${ctx.runId}, ${ctx.userId}) returning id`;
  await journal(ctx, 'stock.reorder_task_created', 'task', task!.id, { itemId: item.id, location: item.location, idempotencyKey: ctx.idempotencyKey }); return { id: task!.id };
 }
 async shop(ctx: Context) {
  const state = await shopifyState(ctx.tx);
  if (!state.connected || !state.complete) {
   const note = !state.connected ? 'Shopify is not connected. Shop quantities were not checked.' : 'Shopify sync is incomplete. Sync it in Settings before checking shop reorder points.';
   await journal(ctx, 'stock.shopify_skipped', 'workflow_run', ctx.runId, { note }); return { connected: state.connected, complete: state.complete, items: [], note };
  }
  const rows = await ctx.tx`select p.id, p.title || case when p.variant_title = 'Default Title' then '' else ' — ' || p.variant_title end as name,
   l.location_name as location, 'units' as unit_label, l.available::text as count, r.reorder_point::text, l.available < r.reorder_point as below_reorder_point
   from shopify_products p join shopify_inventory_levels l using (organisation_id, connection_id, inventory_item_id)
   join shopify_reorder_points r on r.organisation_id = p.organisation_id and r.connection_id = p.connection_id and r.variant_provider_id = p.provider_id
   where p.connection_id = ${state.connection!.id} and p.tracked and p.product_status in ('ACTIVE', 'UNLISTED')
   order by l.location_name, p.provider_id, l.location_provider_id limit 101`;
  if (rows.length > 100) throw problem('stocktake_limit');
  return { connected: true, complete: true, lastSyncedAt: state.lastSyncedAt, items: rows.map(r => itemSchema.parse({ ...r, preferredSupplier: null })) };
 }
 register(registry: Registry) {
  registry.registerStep('stock.items', { kind: 'read', transaction: (ctx, args) => this.items(ctx, args) });
  registry.registerStep('stock.counted', { kind: 'await', transaction: (ctx, args) => this.counted(ctx, args) });
  registry.registerStep('stock.recordCount', { kind: 'write', transaction: (ctx, args) => this.record(ctx, args) });
  registry.registerStep('tasks.createInProject', { kind: 'write', transaction: (ctx, args) => this.task(ctx, args) });
  registry.registerStep('shopify.stockLevels', { kind: 'read', transaction: ctx => this.shop(ctx) });
  const draft = inferenceStep(this.inference, draftOrderEmailInstruction, draftSchema);
  registry.registerStep('draftOrderEmail', { kind: 'infer', retrySafe: true, call: (ctx, args) => {
   const item = itemSchema.parse(args.item), count = countSchema.parse(args.count);
   if (!('call' in draft)) throw Error('Inference binding is not installed');
   return draft.call(ctx, { untrustedStock: { item: item.name, unit: item.unitLabel, count: count.count, reorderPoint: item.reorderPoint, supplier: item.preferredSupplier?.name ?? null, usualQuantity: null } });
  } });
  registry.registerStep('push.counter', { kind: 'notify', retrySafe: true, call: async (ctx: HandlerContext, args) => {
   const item = itemSchema.parse(args.item);
   const deliveries = await this.push.send(ctx.organisationId, ctx.userId, { title: `Count ${item.name}`, body: `Enter the ${item.unitLabel} at ${item.location} in Stock.`, tag: `stock:${item.id}`, url: '/commitments#stock' }, { runId: ctx.runId, actor: { userId: ctx.userId, requestId: ctx.runId } });
   const note = deliveries.length ? 'Count requested. Delivery results are recorded per device.' : 'No subscribed device for the enabling person. Enter counts in Commitments → Stock.';
   await withTenant(this.db, ctx, tx => journal({ ...ctx, tx }, 'stock.count_requested', 'stock_item', item.id, { note })); return { deliveries, note };
  } });
  if (!registry.handlers.has('outbox.create')) registry.registerStep('outbox.create', { kind: 'write', transaction: workflowDraft });
  return registry;
 }
}
