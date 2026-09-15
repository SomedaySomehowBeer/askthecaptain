import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { xeroRole, type Actor } from './connections.ts';
export class XeroService {
 readonly db: Sql;
 constructor(db: Sql) { this.db = db; }
 async read(actor: Actor, org: string, overdueDays?: number, offset = 0) {
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await xeroRole(tx, actor, org);
   return this.readIn(tx, org, overdueDays, offset);
  });
 }
 async readIn(tx: TransactionSql, org: string, overdueDays?: number, offset = 0, forDate?: string) {
   const [connection] = await tx`select id, status, error from connections where provider = 'xero' for share`;
   const [sync] = connection ? await tx`select action, detail, created_at from audit_events where subject_id = ${connection.id} and action in ('xero.sync_started', 'xero.synced', 'xero.sync_failed') order by created_at desc, id desc limit 1` : [];
   const [last] = connection ? await tx`select created_at from audit_events where subject_id = ${connection.id} and action = 'xero.synced' and created_at >= coalesce((select max(created_at) from audit_events where subject_id = ${connection.id} and action = 'xero.connected'), 'epoch'::timestamptz) order by created_at desc, id desc limit 1` : [];
   const state = { connected: connection?.status === 'connected', complete: connection?.status === 'connected' && sync?.action === 'xero.synced', lastSyncedAt: last?.createdAt ?? null,
    error: connection?.error ?? (connection?.status !== 'connected' ? 'Connect Xero in Settings.' : sync?.action !== 'xero.synced' ? sync?.detail.error ?? 'Xero has not been synced yet. Choose Sync now in Settings.' : null) };
   if (!state.connected) return { ...state, invoices: [], totals: null, nextOffset: null };
   const [clock] = await tx`select (current_timestamp at time zone timezone)::date::text as today from organisations where id = ${org}`; const today = forDate ?? clock!.today as string;
   if (overdueDays !== undefined) {
    const rows = await tx`select i.id, i.provider_id, (${today}::date - i.due_date)::int as days_overdue, i.number, i.reference, i.due_date::text, i.currency, i.amount_due::text, i.total::text, i.amount_paid::text, c.name as contact_name, c.email as contact_email
     from xero_invoices i join xero_contacts c using (organisation_id, connection_id) where i.connection_id = ${connection!.id} and c.provider_id = i.contact_provider_id
     and i.type = 'ACCREC' and i.status = 'AUTHORISED' and i.amount_due > 0 and i.due_date < ${today}::date and i.due_date <= ${today}::date - ${overdueDays}::int
     order by i.due_date, i.provider_id limit 1001 offset ${offset}`;
    return { ...state, asOfDate: today, invoices: rows.slice(0, 1000), nextOffset: rows.length > 1000 ? offset + 1000 : null };
   }
   const totals = await tx`select currency,
    coalesce(sum(amount_due) filter (where type = 'ACCREC' and due_date < ${today}::date), 0)::text as overdue_receivables,
    coalesce(sum(amount_due) filter (where type = 'ACCREC' and due_date >= ${today}::date and due_date < date_trunc('week', ${today}::date) + interval '1 week'), 0)::text as due_this_week,
    coalesce(sum(amount_due) filter (where type = 'ACCPAY' and due_date < ${today}::date), 0)::text as overdue_payables
    from xero_invoices where connection_id = ${connection!.id} and status = 'AUTHORISED' and amount_due > 0 group by currency order by currency`;
   return { ...state, asOfDate: today, totals };
 }
}
