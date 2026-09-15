import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { requireMember } from '../mail/store.ts';
import { addresses } from './addresses.ts';
type Actor = { userId: string; requestId: string };
export type ContactInput = { name?: string; email?: string; companyId?: string | null; phone?: string; role?: string; notes?: string; archived?: boolean };
export type CompanyInput = { name?: string; domain?: string | null; notes?: string; archived?: boolean };
const searchPattern = (q: string) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
export class ContactsService {
 readonly #db: Sql;
 constructor(db: Sql) { this.#db = db; }
 private async tenant<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  try {
   return await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => { await requireMember(tx, actor.userId, organisationId); return work(tx); });
  } catch (error) {
   if (error && typeof error === 'object' && 'code' in error && error.code === '23505') throw new HttpError(409, 'already_exists', 'That email or company domain is already saved. Search for the existing record.');
   throw error;
  }
 }
 async list(actor: Actor, org: string, q = '', limit = 50) {
  return this.tenant(actor, org, async (tx) => {
   const rows = await tx`select c.*, co.name as company_name from contacts c left join companies co on co.id = c.company_id
    where c.name ilike ${searchPattern(q)} or c.email ilike ${searchPattern(q)} or co.name ilike ${searchPattern(q)}
    order by c.archived_at nulls first, lower(coalesce(nullif(c.name, ''), c.email)), c.id limit ${limit + 1}`;
   return { contacts: rows.slice(0, limit), hasMore: rows.length > limit };
  });
 }
 async detail(actor: Actor, org: string, id: string) {
  return this.tenant(actor, org, async (tx) => {
   const [contact] = await tx`select c.*, co.name as company_name from contacts c left join companies co on co.id = c.company_id where c.id = ${id}`;
   if (!contact) throw notFound('That contact is not available. Return to People and companies.');
   // The SQL prefilter is only an optimisation; exact parsed addresses decide membership, so
   // ann@example.com cannot see a thread for joann@example.com. No message bodies are read.
   const candidates = await tx`select t.id, m.subject, m.sent_at, m.from_header, m.to_header, m.cc_header, m.bcc_header from mail_messages m
    join mail_threads t on t.id = m.thread_id join connections c on c.id = t.connection_id and c.account_email = t.account_email
    where c.status <> 'disconnected' and (m.from_header ilike ${searchPattern(contact.email)} or m.to_header ilike ${searchPattern(contact.email)} or m.cc_header ilike ${searchPattern(contact.email)} or m.bcc_header ilike ${searchPattern(contact.email)})
    order by m.sent_at desc, m.id desc`;
   const threads = new Map<string, { id: string; subject: string; sentAt: Date }>();
   for (const m of candidates) if (!threads.has(m.id) && addresses([m.fromHeader, m.toHeader, m.ccHeader, m.bccHeader].join(',')).some((a) => a.email === contact.email)) {
    threads.set(m.id, { id: m.id, subject: m.subject, sentAt: m.sentAt }); if (threads.size === 20) break;
   }
   return { contact, threads: [...threads.values()] };
  });
 }
 async saveContact(actor: Actor, org: string, input: ContactInput, id?: string) {
  return this.tenant(actor, org, async (tx) => {
   if (id) {
    const [old] = await tx`select id, archived_at from contacts where id = ${id} for update`;
    if (!old) throw notFound('That contact is not available.');
    if (old.archivedAt && input.archived !== false) throw badRequest('contact_archived', 'This contact is archived. Restore it before editing.');
   }
   if (input.companyId) {
    const [company] = await tx`select co.id from companies co where co.id = ${input.companyId} and (co.archived_at is null
     or exists (select 1 from contacts c where c.id = ${id ?? null}::uuid and c.company_id = co.id)) for share`;
    if (!company) throw badRequest('company_unavailable', 'Choose an active company in this organisation.');
   }
   const values = { ...input, email: input.email?.toLowerCase(), source: 'hand', archivedAt: input.archived === undefined ? undefined : input.archived ? new Date() : null };
   const { archived: _, ...fields } = values;
   const clean = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
   const [contact] = id ? await tx`update contacts set ${tx(clean)} where id = ${id} returning *`
    : await tx`insert into contacts ${tx({ ...clean, organisationId: org })} returning *`;
   await audit(tx, { organisationId: org, actor: { kind: 'person', id: actor.userId }, action: id ? 'contact.updated' : 'contact.created', subjectType: 'contact', subjectId: contact!.id, requestId: actor.requestId, detail: { fields: Object.keys(clean) } });
   return contact!;
  });
 }
 async companies(actor: Actor, org: string, q = '', limit = 100) {
  return this.tenant(actor, org, async (tx) => {
   const rows = await tx`select * from companies where name ilike ${searchPattern(q)} or domain ilike ${searchPattern(q)}
    order by archived_at nulls first, lower(name), id limit ${limit + 1}`;
   return { companies: rows.slice(0, limit), hasMore: rows.length > limit };
  });
 }
 async saveCompany(actor: Actor, org: string, input: CompanyInput, id?: string) {
  return this.tenant(actor, org, async (tx) => {
   if (id) {
    const [old] = await tx`select id, archived_at from companies where id = ${id} for update`;
    if (!old) throw notFound('That company is not available.');
    if (old.archivedAt && input.archived !== false) throw badRequest('company_archived', 'This company is archived. Restore it before editing.');
   }
   const { archived, ...fields } = input;
   const clean = Object.fromEntries(Object.entries({ ...fields, domain: fields.domain?.toLowerCase() ?? fields.domain,
    updatedAt: new Date(), archivedAt: archived === undefined ? undefined : archived ? new Date() : null }).filter(([, value]) => value !== undefined));
   const [company] = id ? await tx`update companies set ${tx(clean)} where id = ${id} returning *`
    : await tx`insert into companies ${tx({ ...clean, organisationId: org })} returning *`;
   await audit(tx, { organisationId: org, actor: { kind: 'person', id: actor.userId }, action: id ? 'company.updated' : 'company.created', subjectType: 'company', subjectId: company!.id, requestId: actor.requestId, detail: { fields: Object.keys(clean) } });
   return company!;
  });
 }
}
