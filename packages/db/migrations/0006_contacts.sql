-- People and companies (D6). Tenant keys protect references even when FK checks bypass RLS.
-- Retain Bcc when Gmail supplies it (typically sent mail), so all known recipients are collected.
alter table mail_messages add column bcc_header text not null default '';
alter table mail_threads add unique (organisation_id, id);
create table companies (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 name text not null check (length(trim(name)) > 0),
 domain text check (domain = lower(domain)),
 notes text not null default '',
 external_refs jsonb not null default '{}' check (jsonb_typeof(external_refs) = 'object'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 archived_at timestamptz,
 unique (organisation_id, id), unique (organisation_id, domain)
);
create table contacts (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 company_id uuid,
 name text not null default '',
 email text not null check (email = lower(email) and length(trim(email)) > 0),
 phone text not null default '',
 role text not null default '',
 notes text not null default '',
 source text not null check (source in ('mail', 'hand', 'import')),
 first_seen_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(),
 last_thread_id uuid,
 archived_at timestamptz,
 unique (organisation_id, id), unique (organisation_id, email),
 foreign key (organisation_id, company_id) references companies(organisation_id, id),
 foreign key (organisation_id, last_thread_id) references mail_threads(organisation_id, id) on delete set null (last_thread_id)
);
create index contacts_company on contacts (organisation_id, company_id);
alter table companies enable row level security;
alter table companies force row level security;
create policy companies_tenant on companies for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table contacts enable row level security;
alter table contacts force row level security;
create policy contacts_tenant on contacts for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update, delete on companies, contacts to app;
