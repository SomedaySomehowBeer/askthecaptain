import { sql } from 'drizzle-orm';
import { boolean, date, foreignKey, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { connections, organisations } from './connections-schema.ts';
import { companies, contacts } from './contacts-schema.ts';
const base = () => ({ id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }), connectionId: uuid('connection_id').notNull(), providerId: text('provider_id').notNull() });
export const xeroContacts = pgTable('xero_contacts', {
 ...base(), name: text('name').notNull(), email: text('email'), phone: text('phone'), isCustomer: boolean('is_customer').notNull(), isSupplier: boolean('is_supplier').notNull(),
 updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(), companyId: uuid('company_id'), contactId: uuid('contact_id')
}, (t) => [unique().on(t.organisationId, t.connectionId, t.providerId),
 foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade'),
 // SQL sets only the nullable reference to NULL, preserving organisation_id.
 foreignKey({ columns: [t.organisationId, t.companyId], foreignColumns: [companies.organisationId, companies.id] }),
 foreignKey({ columns: [t.organisationId, t.contactId], foreignColumns: [contacts.organisationId, contacts.id] })]);
export const xeroInvoices = pgTable('xero_invoices', {
 ...base(), type: text('type', { enum: ['ACCREC', 'ACCPAY'] }).notNull(), contactProviderId: text('contact_provider_id').notNull(), number: text('number'), reference: text('reference'), status: text('status').notNull(),
 date: date('date').notNull(), dueDate: date('due_date'), currency: text('currency').notNull(), total: numeric('total').notNull(), amountDue: numeric('amount_due').notNull(), amountPaid: numeric('amount_paid').notNull(), fullyPaidAt: date('fully_paid_at'), updatedAt: timestamp('updated_at', { withTimezone: true }).notNull()
}, (t) => [unique().on(t.organisationId, t.connectionId, t.providerId),
 foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade'),
 foreignKey({ columns: [t.organisationId, t.connectionId, t.contactProviderId], foreignColumns: [xeroContacts.organisationId, xeroContacts.connectionId, xeroContacts.providerId] }).onDelete('cascade')]);
export const xeroPayments = pgTable('xero_payments', {
 ...base(), invoiceProviderId: text('invoice_provider_id').notNull(), date: date('date').notNull(), amount: numeric('amount').notNull()
}, (t) => [unique().on(t.organisationId, t.connectionId, t.providerId),
 foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade'),
 foreignKey({ columns: [t.organisationId, t.connectionId, t.invoiceProviderId], foreignColumns: [xeroInvoices.organisationId, xeroInvoices.connectionId, xeroInvoices.providerId] }).onDelete('cascade')]);
