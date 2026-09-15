-- D6/D8/D16: Xero grants and tenant-qualified accounting caches.
alter table connections add column provider_account_id text, add column provider_account_name text;
alter table connections alter column account_email drop not null;
alter table connections add check (provider <> 'google' or account_email is not null);
alter table auth_requests drop constraint auth_requests_kind_check;
alter table auth_requests add check (kind in ('oauth', 'session_exchange', 'google_connection', 'xero_connection', 'xero_selection'));
create table xero_contacts (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 connection_id uuid not null, provider_id text not null, name text not null, email text, phone text,
 is_customer boolean not null, is_supplier boolean not null, updated_at timestamptz not null,
 company_id uuid, contact_id uuid,
 unique (organisation_id, connection_id, provider_id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade,
 foreign key (organisation_id, company_id) references companies(organisation_id, id) on delete set null (company_id),
 foreign key (organisation_id, contact_id) references contacts(organisation_id, id) on delete set null (contact_id)
);
create table xero_invoices (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 connection_id uuid not null, provider_id text not null, type text not null check (type in ('ACCREC', 'ACCPAY')),
 contact_provider_id text not null, number text, reference text, status text not null,
 date date not null, due_date date, currency text not null, total numeric not null, amount_due numeric not null,
 amount_paid numeric not null, fully_paid_at date, updated_at timestamptz not null,
 unique (organisation_id, connection_id, provider_id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade,
 foreign key (organisation_id, connection_id, contact_provider_id) references xero_contacts(organisation_id, connection_id, provider_id) on delete cascade
);
create table xero_payments (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 connection_id uuid not null, provider_id text not null, invoice_provider_id text not null, date date not null, amount numeric not null,
 unique (organisation_id, connection_id, provider_id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade,
 foreign key (organisation_id, connection_id, invoice_provider_id) references xero_invoices(organisation_id, connection_id, provider_id) on delete cascade
);
create index xero_invoices_due on xero_invoices (organisation_id, due_date) where status = 'AUTHORISED' and amount_due > 0;
alter table xero_contacts enable row level security;
alter table xero_contacts force row level security;
create policy xero_contacts_tenant on xero_contacts for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table xero_invoices enable row level security;
alter table xero_invoices force row level security;
create policy xero_invoices_tenant on xero_invoices for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table xero_payments enable row level security;
alter table xero_payments force row level security;
create policy xero_payments_tenant on xero_payments for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update, delete on xero_contacts, xero_invoices, xero_payments to app;
-- The system scheduler can discover ids only; all subsequent work uses tenant context.
create function xero_sync_organisations() returns table (organisation_id uuid)
 language sql security definer set search_path = pg_catalog, public, pg_temp as $$
 select c.organisation_id from public.connections c where c.provider = 'xero' and c.status = 'connected' and c.provider_account_id is not null
$$;
revoke all on function xero_sync_organisations() from public;
grant execute on function xero_sync_organisations() to app;
