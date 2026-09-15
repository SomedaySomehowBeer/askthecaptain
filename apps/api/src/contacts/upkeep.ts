import type { TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
import { addresses, isCounterparty, publicDomains } from './addresses.ts';

/** Backfill cached headers, optionally limited to a persisted mail batch. Contacts and their mail
 * commit together. Human edits and archives survive resync, deletion and account changes. */
export async function upkeepContacts(tx: TransactionSql, organisationId: string, accountEmail: string, providerIds?: string[]) {
 const messages = await tx`select m.thread_id, m.sent_at, m.from_header, m.to_header, m.cc_header, m.bcc_header from mail_messages m
  join mail_threads t on t.id = m.thread_id where t.account_email = ${accountEmail}
  and (${providerIds === undefined} or t.provider_id = any(${tx.array(providerIds ?? [])}::text[])) order by m.sent_at, m.id`;
 const seen = new Map<string, { name: string; first: Date; last: Date; thread: string }>();
 for (const m of messages) for (const address of addresses([m.fromHeader, m.toHeader, m.ccHeader, m.bccHeader].join(','))) {
  if (!isCounterparty(address.email, accountEmail)) continue;
  const previous = seen.get(address.email);
  seen.set(address.email, { name: address.name || previous?.name || '', first: previous?.first ?? m.sentAt, last: m.sentAt, thread: m.threadId });
 }
 let created = 0; let updated = 0; let companiesCreated = 0;
 for (const [email, contact] of seen) {
  const [existing] = await tx`select id, source, archived_at from contacts where email = ${email} for update`;
  let companyId: string | null = null; const domain = email.split('@')[1]!;
  if (!publicDomains.has(domain) && (!existing || (existing.source === 'mail' && !existing.archivedAt))) {
   const added = await tx`insert into companies (organisation_id, name, domain) values (${organisationId}, ${domain}, ${domain})
    on conflict (organisation_id, domain) do nothing returning id`;
   companiesCreated += added.length;
   const [company] = await tx`select id from companies where domain = ${domain} and archived_at is null`; companyId = company?.id ?? null;
  }
  const added = await tx`insert into contacts (organisation_id, company_id, name, email, source, first_seen_at, last_seen_at, last_thread_id)
   values (${organisationId}, ${companyId}, ${contact.name}, ${email}, 'mail', ${contact.first}, ${contact.last}, ${contact.thread})
   on conflict (organisation_id, email) do nothing returning id`;
  if (added.length) { created++; continue; }
  await tx`update contacts set
   name = case when source = 'mail' and archived_at is null and ${contact.name} <> '' and ${contact.last} >= last_seen_at then ${contact.name} else name end,
   company_id = case when source = 'mail' and archived_at is null then ${companyId}::uuid else company_id end,
   first_seen_at = least(first_seen_at, ${contact.first}),
   last_thread_id = case when ${contact.last} >= last_seen_at then ${contact.thread}::uuid else last_thread_id end,
   last_seen_at = greatest(last_seen_at, ${contact.last}) where email = ${email}`;
  updated++;
 }
 await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'contacts.synced', subjectType: 'organisation', subjectId: organisationId,
  detail: { addresses: seen.size, created, updated, companiesCreated } });
}
