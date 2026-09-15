import { z } from 'zod';
import type { TransactionSql } from '@captain/db';
const instant = z.string().transform((s, c) => {
 const legacy = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(s);
 const date = new Date(legacy ? Number(legacy[1]) : /(?:Z|[+-]\d\d:\d\d)$/.test(s) ? s : `${s}Z`);
 if (!Number.isFinite(date.getTime())) { c.addIssue({ code: 'custom', message: 'Invalid Xero date' }); return z.NEVER; } return date.toISOString();
});
const date = instant.transform((s) => s.slice(0, 10));
const amount = z.union([z.number().finite(), z.string()]).transform(String).pipe(z.string().regex(/^-?\d+(?:\.\d+)?$/));
const id = z.string().min(1).max(200);
export const contactSchema = z.object({ ContactID: id, Name: z.string().min(1), EmailAddress: z.string().optional(), ContactStatus: z.string().default('ACTIVE'),
 Phones: z.array(z.object({ PhoneType: z.string().optional(), PhoneNumber: z.string().optional(), PhoneAreaCode: z.string().optional(), PhoneCountryCode: z.string().optional() })).default([]),
 IsCustomer: z.boolean(), IsSupplier: z.boolean(), UpdatedDateUTC: instant });
export const invoiceSchema = z.object({ InvoiceID: id, Type: z.enum(['ACCREC', 'ACCPAY']), Contact: z.object({ ContactID: id }), InvoiceNumber: z.string().optional(), Reference: z.string().optional(), Status: z.string(),
 Date: date, DueDate: date.optional(), CurrencyCode: z.string().regex(/^[A-Z]{3}$/), Total: amount, AmountDue: amount, AmountPaid: amount, FullyPaidOnDate: date.optional(), UpdatedDateUTC: instant });
export const paymentSchema = z.object({ PaymentID: id, Invoice: z.object({ InvoiceID: id }).optional(), Date: date.optional(), Amount: amount.optional(), Status: z.enum(['AUTHORISED', 'DELETED']) });
export async function saveContact(tx: TransactionSql, org: string, connection: string, tenant: string, c: z.infer<typeof contactSchema>) {
 const phone = c.Phones.find((p) => p.PhoneNumber && p.PhoneType === 'DEFAULT') ?? c.Phones.find((p) => p.PhoneNumber && p.PhoneType !== 'FAX');
 const number = phone ? [phone.PhoneCountryCode, phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(' ') : null;
 const email = c.EmailAddress?.trim().toLowerCase() || null;
 let companyId: string | null = null; let contactId: string | null = null;
 if (c.ContactStatus === 'ACTIVE') {
  const companies = await tx`select id from companies where name = ${c.Name} and archived_at is null limit 2 for update`;
  if (companies.length === 1) {
   companyId = companies[0]!.id; const ref = `xero:${tenant}`;
   await tx`update companies set external_refs = external_refs || ${tx.json({ [ref]: c.ContactID })}, updated_at = now() where id = ${companyId} and not (external_refs ? ${ref})`;
  }
  if (email && z.string().email().safeParse(email).success) {
   await tx`insert into contacts (organisation_id, company_id, name, email, phone, source) values (${org}, ${companyId}, ${c.Name}, ${email}, ${number ?? ''}, 'import') on conflict (organisation_id, email) do nothing`;
   const [person] = await tx`select id from contacts where email = ${email} and archived_at is null`; contactId = person?.id ?? null;
  }
 }
 await tx`insert into xero_contacts (organisation_id, connection_id, provider_id, name, email, phone, is_customer, is_supplier, updated_at, company_id, contact_id)
  values (${org}, ${connection}, ${c.ContactID}, ${c.Name}, ${email}, ${number}, ${c.IsCustomer}, ${c.IsSupplier}, ${c.UpdatedDateUTC}, ${companyId}, ${contactId})
  on conflict (organisation_id, connection_id, provider_id) do update set name = excluded.name, email = excluded.email, phone = excluded.phone, is_customer = excluded.is_customer,
  is_supplier = excluded.is_supplier, updated_at = excluded.updated_at, company_id = excluded.company_id, contact_id = excluded.contact_id`;
}
export async function saveInvoice(tx: TransactionSql, org: string, connection: string, i: z.infer<typeof invoiceSchema>) {
 await tx`insert into xero_invoices (organisation_id, connection_id, provider_id, type, contact_provider_id, number, reference, status, date, due_date, currency, total, amount_due, amount_paid, fully_paid_at, updated_at)
  values (${org}, ${connection}, ${i.InvoiceID}, ${i.Type}, ${i.Contact.ContactID}, ${i.InvoiceNumber ?? null}, ${i.Reference ?? null}, ${i.Status}, ${i.Date}, ${i.DueDate ?? null}, ${i.CurrencyCode}, ${i.Total}, ${i.AmountDue}, ${i.AmountPaid}, ${i.FullyPaidOnDate ?? null}, ${i.UpdatedDateUTC})
  on conflict (organisation_id, connection_id, provider_id) do update set type = excluded.type, contact_provider_id = excluded.contact_provider_id, number = excluded.number, reference = excluded.reference, status = excluded.status,
  date = excluded.date, due_date = excluded.due_date, currency = excluded.currency, total = excluded.total, amount_due = excluded.amount_due, amount_paid = excluded.amount_paid, fully_paid_at = excluded.fully_paid_at, updated_at = excluded.updated_at`;
}
export async function savePayment(tx: TransactionSql, org: string, connection: string, p: z.infer<typeof paymentSchema>) {
 if (p.Status === 'DELETED') { await tx`delete from xero_payments where connection_id = ${connection} and provider_id = ${p.PaymentID}`; return; }
 // Payments on credit notes, overpayments and prepayments are outside this invoice cache.
 if (!p.Invoice) return;
 if (!p.Date || p.Amount === undefined) throw new Error('Incomplete Xero payment');
 await tx`insert into xero_payments (organisation_id, connection_id, provider_id, invoice_provider_id, date, amount) values (${org}, ${connection}, ${p.PaymentID}, ${p.Invoice.InvoiceID}, ${p.Date}, ${p.Amount})
  on conflict (organisation_id, connection_id, provider_id) do update set invoice_provider_id = excluded.invoice_provider_id, date = excluded.date, amount = excluded.amount`;
}
