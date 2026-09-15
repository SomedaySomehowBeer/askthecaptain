import type { Sql, TransactionSql } from '@captain/db';
import { CalendarService } from '../calendar/service.ts';
import { addresses } from '../contacts/addresses.ts';
import { shopifyState } from '../shopify/connections.ts';
import { XeroService } from '../xero/service.ts';
import { addDays, dateRange } from './dates.ts';
export type Source = { kind: string; id: string; label: string; url: string };
export type RetrievedRow = { source: Source; data: Record<string, unknown> };
export type Retrieval = { today: string; timezone: string; range: ReturnType<typeof dateRange>; rows: RetrievedRow[]; warnings: string[]; scope: string[] };
const cap = 20;
const normal = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const stop = new Set('who what when where why how is are was were have has had does did do will would could should tell about with from for the and our your their them they this that there these those please mail email emails message messages thread threads calendar meeting meetings event events tasks task due overdue unpaid paid invoice invoices money amount amounts stock counted shop inventory open suggested customer customers company companies supplier suppliers today tomorrow yesterday last next month week january february march april may june july august september october november december'.split(' '));
const words = (question: string) => [...new Set(normal(question).split(' ').filter(w => w.length >= 3 && !stop.has(w)))].slice(0, 12);
export async function retrieve(db: Sql, tx: TransactionSql, org: string, question: string, now = new Date()): Promise<Retrieval> {
 const [clock] = await tx`select timezone, (${now.toISOString()}::timestamptz at time zone timezone)::date::text as today from organisations where id = ${org}`;
 const today = String(clock!.today), timezone = String(clock!.timezone), q = question.toLowerCase(), range = dateRange(question, today);
 const nameQuestion = q.replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g, ' ');
 const rows: RetrievedRow[] = [], warnings: string[] = [], scope: string[] = [], terms = words(nameQuestion);
 const add = (kind: string, items: Record<string, any>[], label: (r: any) => string, url: (r: any) => string) => {
  if (items.length > cap) warnings.push(`Only the first ${cap} ${kind} records are included; more matched. This is not a complete total.`);
  for (const item of items.slice(0, cap)) { const { id, ...data } = item; rows.push({ source: { kind, id: `${kind}:${id}`, label: label(item).slice(0, 200), url: url(item) }, data }); }
 };
 const matched = (column: ReturnType<TransactionSql['unsafe']>) => tx`exists(select 1 from unnest(${tx.array(terms)}::text[]) term where position(' ' || term || ' ' in ' ' || regexp_replace(lower(${column}), '[^[:alnum:]]+', ' ', 'g') || ' ') > 0)`;
 // Only these fixed identifier fragments enter SQL; all question text remains bound parameters.
 const emails = [...new Set((q.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []))].slice(0, 20);
 const companies = await tx`select id, left(name, 200) as name, domain from companies where archived_at is null
  and (${matched(tx.unsafe('name'))} or position(' ' || regexp_replace(lower(name), '[^[:alnum:]]+', ' ', 'g') || ' ' in ${' ' + normal(nameQuestion) + ' '}) > 0) order by name, id limit 21`;
 const contacts = await tx`select c.id, c.email, left(c.name, 200) as name, left(c.role, 200) as role, c.company_id, left(co.name, 200) as company_name
  from contacts c left join companies co on co.id = c.company_id and co.archived_at is null where c.archived_at is null
  and (c.email = any(${tx.array(emails)}::text[]) or ${matched(tx.unsafe('c.name'))} or c.company_id = any(${tx.array(companies.slice(0, cap).map(c => c.id))}::uuid[])) order by c.name, c.email, c.id limit 21`;
 add('company', companies, c => c.name, c => { const contact = contacts.find(p => p.companyId === c.id); return contact ? `/inbox/contacts/${contact.id}` : '/inbox'; });
 add('contact', contacts, c => c.name || c.email, c => `/inbox/contacts/${c.id}`);
 const people = [...new Set([...emails, ...contacts.slice(0, cap).map(c => String(c.email))])];
 if (companies.length && !people.length) warnings.push('No contact email was matched for the named company, so related mail and attendees could not be retrieved.');
 if (companies.length || contacts.length) scope.push('Names match whole words of names or an exact email; all matching people are shown when a name is ambiguous.');
 const money = /\b(invoice|invoices|money|amount|amounts|paid|unpaid|payment|payments|receivable|receivables|bill|bills|owe|owed|owing|outstanding|debt)\b/.test(q);
 const tasks = /\b(task|tasks|commitment|commitments|duty|duties|deadline|deadlines|suggested|to do|due soon)\b/.test(q) || /\b(due|overdue)\b/.test(q) && !money;
 const mail = /\b(mail|email|emails|message|messages|thread|threads|discussed|correspondence|said|say)\b/.test(q) || people.length > 0 || companies.length > 0;
 const calendar = /\b(calendar|meeting|meetings|event|events|appointment|appointments|schedule)\b/.test(q);
 const stock = /\b(stock|inventory|counted|count|counts|shop|shopify|reorder)\b/.test(q);
 if (tasks) {
  scope.push(`Tasks: ${/\boverdue\b/.test(q) && range.label === 'today' ? `overdue as of ${today}` : range.explicit ? `due dates in ${range.from} to ${range.to} (end exclusive)` : 'open, in-progress and suggested tasks unless another status is named'}.`);
  const items = await tx`select t.id, left(t.title, 300) as title, t.status, t.due::text, left(p.name, 200) as project, coalesce(nullif(u.name, ''), u.email) as owner
   from tasks t join projects p on p.id = t.project_id left join users u on u.id = t.owner_id where p.archived_at is null
   and (case when ${/\bsuggested\b/.test(q)} then t.status = 'suggested' when ${/\b(done|completed|finished)\b/.test(q)} then t.status = 'done'
    when ${/\bopen\b/.test(q)} then t.status in ('open', 'in_progress') else t.status in ('open', 'in_progress', 'suggested') end)
   and (not ${/\boverdue\b/.test(q)} or t.due < ${today}::date)
   and (not ${range.explicit && !(/\boverdue\b/.test(q) && range.label === 'today') || /\bdue soon\b/.test(q)} or (t.due >= ${range.from}::date and t.due < ${range.to}::date))
   order by t.due nulls last, t.id limit 21`;
  add('task', items, t => t.title, () => '/commitments');
 }
 if (money) {
  const state = await new XeroService(db).readIn(tx, org);
  if (!state.connected || !state.complete) warnings.push(state.error ?? 'Xero data is incomplete. Sync Xero in Settings → Connections.');
  const paid = /\bpaid\b/.test(q) && !/\bunpaid\b/.test(q), overdue = /\boverdue\b/.test(q);
  const asOfToday = !paid && range.label === 'today' && !/\b(issued|dated|due)\b/.test(q);
  if (asOfToday) scope.push(`Today is the as-of date for unpaid balances, not an invoice issue-date filter.`);
  scope.push(`Invoices: ${paid ? 'fully paid invoices, dated by fully-paid date (not a cash-flow or payments report)' : overdue ? 'overdue unpaid invoices, dated by due date' : 'unpaid invoices, dated by due date when requested; otherwise invoice date'}. Amounts retain their currencies.`);
  const items = !state.connected ? [] : await tx`select i.id, i.number, i.type, case when i.type = 'ACCREC' then 'customer owes the business' else 'the business owes the supplier' end as direction, i.status, i.date::text, i.due_date::text, i.fully_paid_at::text,
   i.currency, i.total::text, i.amount_due::text, i.amount_paid::text, left(c.name, 200) as contact_name, c.email as contact_email
   from xero_invoices i join xero_contacts c using (organisation_id, connection_id) join connections cn on cn.id = i.connection_id
   where c.provider_id = i.contact_provider_id and cn.status = 'connected'
   and (case when ${paid} then i.status = 'PAID' else i.status = 'AUTHORISED' and i.amount_due > 0 end)
   and (not ${overdue} or i.due_date < ${today}::date)
   and (not ${range.explicit && !asOfToday} or (case when ${paid} then i.fully_paid_at when ${overdue || /\bdue\b/.test(q)} then i.due_date else i.date end >= ${range.from}::date
    and case when ${paid} then i.fully_paid_at when ${overdue || /\bdue\b/.test(q)} then i.due_date else i.date end < ${range.to}::date))
   and (not ${people.length > 0 || companies.length > 0} or lower(c.email) = any(${tx.array(people)}::text[]) or c.company_id = any(${tx.array(companies.slice(0, cap).map(c => c.id))}::uuid[])
    or lower(c.name) = any(${tx.array(companies.slice(0, cap).map(c => String(c.name).toLowerCase()))}::text[]))
   order by i.due_date nulls last, i.id limit 21`;
  add('invoice', items, i => `${i.type === 'ACCPAY' ? 'Bill' : 'Invoice'} ${i.number || '(no number)'} · ${i.contactName}`, () => '/settings/connections');
 }
 if (mail) {
  const [conn] = await tx`select id, status, account_email from connections where provider = 'google'`;
  const [sync] = await tx`select action, detail from audit_events where action in ('mail.synced', 'mail.sync_failed', 'mail.sync_started') order by created_at desc, id desc limit 1`;
  if (conn?.status !== 'connected' || sync?.action !== 'mail.synced') warnings.push('Recent mail is unavailable or incompletely synced. Check Inbox and Settings → Connections.');
  const from = range.explicit && range.from > addDays(today, -60) ? range.from : addDays(today, -60);
  const to = range.explicit && range.to < addDays(today, 1) ? range.to : addDays(today, 1);
  scope.push(`Mail: subjects and snippets in ${from} to ${to} (end exclusive), at most the last 60 days; headers are used only to match people.`);
  if (range.explicit && range.from < addDays(today, -60)) warnings.push('The requested mail range extends beyond the 60-day retrieval window. Older mail is not included.');
  const patterns = people.map(email => `%${email.replace(/[\\%_]/g, '\\$&')}%`);
  const candidates = !conn || conn.status === 'disconnected' || (companies.length > 0 && !people.length) ? [] : await tx`select m.thread_id as id, m.subject, m.snippet, m.sent_at, m.from_header, m.to_header, m.cc_header, m.bcc_header
   from mail_messages m join mail_threads t on t.id = m.thread_id where t.connection_id = ${conn.id} and t.account_email = ${conn.accountEmail}
   and m.sent_at >= ${from}::date::timestamp at time zone ${timezone} and m.sent_at < ${to}::date::timestamp at time zone ${timezone} and m.sent_at <= ${now.toISOString()}::timestamptz and m.sent_at >= ${now.toISOString()}::timestamptz - interval '60 days'
   and (not ${people.length > 0} or m.from_header ilike any(${tx.array(patterns)}::text[]) or m.to_header ilike any(${tx.array(patterns)}::text[])
    or m.cc_header ilike any(${tx.array(patterns)}::text[]) or m.bcc_header ilike any(${tx.array(patterns)}::text[])) order by m.sent_at desc, m.id desc limit 1001`;
  if (candidates.length > 1000) warnings.push('Mail matching searched only the newest 1000 candidate messages; older matching threads may be missing.');
  const unique = new Map<string, Record<string, unknown>>();
  for (const m of candidates.slice(0, 1000)) {
   if (people.length && ![m.fromHeader, m.toHeader, m.ccHeader, m.bccHeader].some(h => addresses(h).some(a => people.includes(a.email)))) continue;
   if (!unique.has(m.id)) unique.set(m.id, { id: m.id, subject: m.subject.slice(0, 300), snippet: m.snippet.slice(0, 1000), sentAt: m.sentAt });
   if (unique.size > cap) break;
  }
  add('thread', [...unique.values()], t => t.subject || '(No subject)', t => `/inbox/${t.id}`);
 }
 if (calendar) {
  const value = await new CalendarService(db).readIn(tx, org, { from: range.from, to: range.to });
  const hasAccess = value.connection?.scopes.some((s: string) => ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'].includes(s));
  if (!hasAccess || value.connection?.status !== 'connected' || !('covered' in value) || !value.covered || value.lastSync?.detail.success !== true) warnings.push('Calendar data is unavailable or incompletely synced for this range. Check Calendar.');
  scope.push(`Events overlapping ${range.from} to ${range.to} (end exclusive), in ${timezone}; primary and selected calendars only.`);
  const events = 'events' in value ? value.events : [];
  const matching = companies.length && !people.length ? [] : people.length ? events.filter(e => e.attendees.some((a: { email: string }) => people.includes(a.email.toLowerCase()))) : events;
  add('event', matching.map(e => ({ id: e.id, summary: e.summary.slice(0, 300), location: e.location.slice(0, 300), startsAt: e.startsAt, endsAt: e.endsAt, allDay: e.allDay, startDate: e.startDate, endDate: e.endDate })), e => e.summary || '(No title)', () => `/calendar?week=${range.from}`);
 }
 if (stock) {
  scope.push('Stock is the latest counted observation or Shopify quantity; it cannot reconstruct historical stock or movements.');
  if (range.explicit) warnings.push('Stock values are current saved observations, not stock as of the requested historical date.');
  const items = await tx`select id, left(name, 200) as name, left(location, 200) as location, unit_label, current_count::text, counted_at, reorder_point::text
   from stock_items where archived_at is null order by location, name, id limit 21`;
  add('stock', items, i => `${i.name} · ${i.location}`, () => '/commitments#stock');
  const state = await shopifyState(tx);
  if (!state.connected || !state.complete) warnings.push(state.error ?? 'Shopify data is incomplete. Check Settings → Connections.');
  const shop = !state.connected ? [] : await tx`select p.id || ':' || coalesce(l.location_provider_id, 'unknown') as id, left(p.title, 200) as title, left(p.variant_title, 200) as variant_title, p.sku,
   l.location_name, case when p.tracked then l.available else null end as available, l.updated_at, p.tracked
   from shopify_products p left join shopify_inventory_levels l using (organisation_id, connection_id, inventory_item_id)
   where p.connection_id = ${state.connection!.id} and p.product_status in ('ACTIVE', 'UNLISTED') order by p.title, p.id, l.location_provider_id limit 21`;
  add('shop_stock', shop, i => `${i.title} · ${i.locationName ?? 'unknown location'}`, () => '/commitments#stock');
 }
 if (!rows.length) warnings.push('No matching records were retrieved. This does not establish that none exist; try a full name, email, source type or supported date range.');
 return { today, timezone, range, rows, warnings, scope };
}
