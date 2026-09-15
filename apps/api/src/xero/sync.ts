import { randomUUID } from 'node:crypto';
import { XeroError, type Resource } from '@captain/connectors/xero';
import { withTenant, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { HttpError } from '../errors.ts';
import type { XeroConnections } from './connections.ts';
import { contactSchema, invoiceSchema, paymentSchema, saveContact, saveInvoice, savePayment } from './store.ts';
const busy = () => new HttpError(409, 'xero_sync_running', 'Xero sync is already running. Check again shortly.');
const failed = 'Xero sync did not finish. Cached money may be incomplete. Try Sync now again; reconnect Xero if access has expired.';
const rateSchema = z.object({ calls: z.array(z.number()), retryAt: z.number().default(0) });
/** Provider calls happen outside transactions. Connection + fenced lease locks guard every page,
 * including a replaced grant, another API process, and a process resuming after lease expiry. */
export class XeroSync {
 readonly connections: XeroConnections; readonly now: () => number; readonly sleep: (ms: number) => Promise<void>;
 constructor(connections: XeroConnections, now = Date.now, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) { this.connections = connections; this.now = now; this.sleep = sleep; }
 async organisations(): Promise<string[]> { return (await this.connections.db`select organisation_id from xero_sync_organisations()`).map((r) => r.organisationId); }
 async run(org: string) {
  const { db, client } = this.connections; const runId = randomUUID(); let conn: { id: string; providerAccountId: string } | undefined; let acquired = false;
  const counts = { contacts: 0, invoices: 0, payments: 0, skippedPayments: 0 };
  const batch = <T>(work: (tx: TransactionSql) => Promise<T>) => withTenant(db, { organisationId: org }, async (tx) => {
   const [current] = await tx`select provider_account_id, status from connections where id = ${conn!.id} for update`;
   if (current?.status !== 'connected' || current.providerAccountId !== conn!.providerAccountId) throw busy();
   const lock = await tx`update sync_cursors set updated_at = clock_timestamp() where connection_id = ${conn!.id} and resource = 'xero.sync-lock' and cursor = ${runId} and updated_at > clock_timestamp() - interval '2 minutes' returning id`;
   if (!lock.length) throw busy(); return work(tx);
  });
  const journal = (tx: TransactionSql, action: string, detail: Record<string, unknown>) => audit(tx, { organisationId: org, actor: { kind: 'system' }, action, subjectType: 'connection', subjectId: conn!.id, detail });
  const rateResource = () => `xero.rate:${conn!.providerAccountId}`;
  const request = async <T>(work: (token: string) => Promise<T>): Promise<T> => {
   // Sliding windows persist across restarts; attempts count even if their response is lost.
   for (let attempt = 0; attempt < 4; attempt++) {
    const delay = await batch(async (tx) => {
     const [row] = await tx`select cursor from sync_cursors where connection_id = ${conn!.id} and resource = ${rateResource()} for update`;
     const state = row ? rateSchema.parse(JSON.parse(row.cursor)) : { calls: [], retryAt: 0 };
     const now = this.now(); state.calls = state.calls.filter((t) => t > now - 86_400_000);
     if (state.retryAt > now) throw new XeroError(429, (state.retryAt - now) / 1000);
     if (state.calls.length >= 5000) throw new XeroError(429, (state.calls[0]! + 86_400_000 - now) / 1000);
     const minute = state.calls.filter((t) => t > now - 60_000);
     if (minute.length >= 60) return minute[0]! + 60_001 - now;
     state.calls.push(now);
     await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${org}, ${conn!.id}, ${rateResource()}, ${JSON.stringify(state)})
      on conflict (organisation_id, connection_id, resource) do update set cursor = excluded.cursor, updated_at = now()`;
     return 0;
    });
    if (delay > 0) { for (let left = delay; left > 0; left -= 30_000) { await this.sleep(Math.min(left, 30_000)); await batch(async () => {}); } continue; }
    const token = await this.connections.accessToken(undefined, org, conn!.id);
    try { return await work(token); } catch (error) {
     if (error instanceof XeroError && error.status === 429) await batch(async (tx) => {
      const [row] = await tx`select cursor from sync_cursors where connection_id = ${conn!.id} and resource = ${rateResource()}`;
      const state = rateSchema.parse(JSON.parse(row!.cursor)); state.retryAt = this.now() + error.retryAfter * 1000;
      await tx`update sync_cursors set cursor = ${JSON.stringify(state)}, updated_at = now() where connection_id = ${conn!.id} and resource = ${rateResource()}`;
     }); throw error;
    }
   } throw new XeroError(429);
  };
  try {
   conn = await withTenant(db, { organisationId: org }, async (tx) => { const [row] = await tx<{ id: string; providerAccountId: string }[]>`select id, provider_account_id from connections where provider = 'xero' and status = 'connected' and provider_account_id is not null`; return row; });
   if (!conn || !client) throw new XeroError();
   acquired = await withTenant(db, { organisationId: org }, async (tx) => (await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${org}, ${conn!.id}, 'xero.sync-lock', ${runId})
    on conflict (organisation_id, connection_id, resource) do update set cursor = excluded.cursor, updated_at = clock_timestamp() where sync_cursors.updated_at < clock_timestamp() - interval '2 minutes' returning id`).length > 0);
   if (!acquired) throw busy();
   await batch((tx) => journal(tx, 'xero.sync_started', { error: 'Xero sync is running. Cached money may be incomplete; check again shortly.' }));
   const ensureContact = async (id: string) => {
    const exists = await batch(async (tx) => (await tx`select id from xero_contacts where connection_id = ${conn!.id} and provider_id = ${id}`).length);
    if (!exists) { const c = contactSchema.parse(await request((token) => client.one(token, conn!.providerAccountId, 'Contacts', id))); if (c.ContactID !== id) throw new XeroError(); await batch(async (tx) => { await saveContact(tx, org, conn!.id, conn!.providerAccountId, c); await journal(tx, 'xero.page_synced', { resource: 'Contacts', count: 1, backfill: true }); }); counts.contacts++; }
   };
   const ensureInvoice = async (id: string) => {
    const exists = await batch(async (tx) => (await tx`select id from xero_invoices where connection_id = ${conn!.id} and provider_id = ${id}`).length);
    if (!exists) { const i = invoiceSchema.parse(await request((token) => client.one(token, conn!.providerAccountId, 'Invoices', id))); if (i.InvoiceID !== id) throw new XeroError(); await ensureContact(i.Contact.ContactID); await batch(async (tx) => { await saveInvoice(tx, org, conn!.id, i); await journal(tx, 'xero.page_synced', { resource: 'Invoices', count: 1, backfill: true }); }); counts.invoices++; }
   };
   for (const resource of ['Contacts', 'Invoices', 'Payments'] as const) {
    const key = `xero.${resource.toLowerCase()}`;
    const previous = await batch(async (tx) => { const [row] = await tx`select cursor from sync_cursors where connection_id = ${conn!.id} and resource = ${key}`; return row?.cursor as string | undefined; });
    // Save the pre-fetch time only after every page; overlap boundaries for provider clock skew.
    const started = new Date(this.now() - 60_000).toISOString(); let complete = false;
    for (let page = 1; page <= 5000; page++) {
     const items = await request((token) => client.page(token, conn!.providerAccountId, resource as Resource, page, previous));
     if (resource === 'Contacts') { const contacts = items.map((i) => contactSchema.parse(i)); await batch(async (tx) => { for (const c of contacts) await saveContact(tx, org, conn!.id, conn!.providerAccountId, c); await journal(tx, 'xero.page_synced', { resource, count: items.length }); }); counts.contacts += contacts.length; }
     if (resource === 'Invoices') { const invoices = items.map((i) => invoiceSchema.parse(i)); for (const id of new Set(invoices.map((i) => i.Contact.ContactID))) await ensureContact(id);
      await batch(async (tx) => { for (const i of invoices) await saveInvoice(tx, org, conn!.id, i); await journal(tx, 'xero.page_synced', { resource, count: items.length }); }); counts.invoices += invoices.length; }
     if (resource === 'Payments') { const payments = items.map((p) => paymentSchema.parse(p)); for (const id of new Set(payments.filter((p) => p.Status !== 'DELETED').flatMap((p) => p.Invoice ? [p.Invoice.InvoiceID] : []))) await ensureInvoice(id);
      await batch(async (tx) => { for (const p of payments) await savePayment(tx, org, conn!.id, p); await journal(tx, 'xero.page_synced', { resource, count: items.length }); }); counts.payments += payments.filter((p) => p.Invoice || p.Status === 'DELETED').length; counts.skippedPayments += payments.filter((p) => !p.Invoice && p.Status !== 'DELETED').length; }
     if (items.length < 100) { complete = true; break; }
    }
    if (!complete) throw new XeroError();
    await batch(async (tx) => { await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${org}, ${conn!.id}, ${key}, ${started}) on conflict (organisation_id, connection_id, resource) do update set cursor = excluded.cursor, updated_at = now()`; });
   }
   await batch((tx) => journal(tx, 'xero.synced', { ...counts, success: true })); return counts;
  } catch (error) {
   if (error instanceof HttpError && error.code === 'xero_sync_running') throw error;
   const message = error instanceof XeroError && error.status === 429 ? `Xero’s rate limit paused sync. Try again after ${new Date(this.now() + error.retryAfter * 1000).toISOString()}. Cached money may be incomplete.` : failed;
   if (acquired) await withTenant(db, { organisationId: org }, async (tx) => {
    const [lock] = await tx`select id from sync_cursors where connection_id = ${conn!.id} and resource = 'xero.sync-lock' and cursor = ${runId}`;
    if (lock) await journal(tx, 'xero.sync_failed', { ...counts, success: false, error: message });
   }); throw new HttpError(503, 'xero_sync_failed', message);
  } finally { if (acquired) await withTenant(db, { organisationId: org }, async (tx) => { await tx`delete from sync_cursors where connection_id = ${conn!.id} and resource = 'xero.sync-lock' and cursor = ${runId}`; }); }
 }
}
export function startXeroSchedule(sync: Pick<XeroSync, 'organisations' | 'run'>, disabled = false, intervalMs = 900_000) {
 if (disabled) return async () => {}; let active: Promise<void> | undefined;
 const tick = () => { if (active) return; active = (async () => { for (const org of await sync.organisations()) await sync.run(org).catch(() => undefined); })().catch(() => { console.error('[xero] Scheduled sync could not reach its database.'); }).finally(() => { active = undefined; }); };
 const timer = setInterval(tick, intervalMs); timer.unref(); tick(); return async () => { clearInterval(timer); await active; };
}
