-- D2/D4/D5/D6/D13: durable triage, short-lived extracted text and person-sent mail.
alter table workflow_enablements add column mail_cursor uuid;
alter table mail_messages add column rfc_message_id text not null default '';
create table mail_triage (
 organisation_id uuid not null references organisations(id) on delete cascade,
 thread_id uuid not null, category text not null, needs_owner boolean not null,
 summary text not null, facts jsonb not null, produced_by uuid not null, model text not null,
 source_message_id uuid not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key (organisation_id, thread_id),
 foreign key (organisation_id, thread_id) references mail_threads(organisation_id, id) on delete cascade,
 foreign key (organisation_id, source_message_id) references mail_messages(organisation_id, id) on delete cascade,
 foreign key (organisation_id, produced_by) references workflow_runs(organisation_id, id) on delete cascade
);
create table attachment_text (
 organisation_id uuid not null references organisations(id) on delete cascade,
 message_id uuid not null, attachment_id text not null, text text not null check (char_length(text) <= 20000),
 extracted_at timestamptz not null default now(), expires_at timestamptz not null default now() + interval '24 hours',
 primary key (organisation_id, message_id, attachment_id),
 foreign key (organisation_id, message_id) references mail_messages(organisation_id, id) on delete cascade,
 check (expires_at > extracted_at and expires_at <= extracted_at + interval '24 hours')
);
create index attachment_text_expiry on attachment_text(expires_at);
create table outbox (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 thread_id uuid, connection_id uuid not null, account_email text not null,
 "to" text[] not null, cc text[] not null default '{}', subject text not null, body text not null,
 in_reply_to text not null default '', created_by uuid, created_by_person uuid references users(id) on delete set null,
 idempotency_key text not null, state text not null default 'drafted' check (state in ('drafted', 'sent', 'discarded')),
 -- Commit intent BEFORE sending. An ambiguous retry only reconciles the stable RFC Message-ID.
 send_started_at timestamptz, sent_by uuid references users(id) on delete set null,
 sent_at timestamptz, provider_message_id text, discarded_by uuid references users(id) on delete set null, discarded_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (organisation_id, id), unique (organisation_id, idempotency_key),
 foreign key (organisation_id, thread_id) references mail_threads(organisation_id, id) on delete set null (thread_id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade,
 foreign key (organisation_id, created_by) references workflow_runs(organisation_id, id) on delete set null (created_by),
 check ((state = 'sent') = (sent_at is not null and provider_message_id is not null)),
 check ((state = 'discarded') = (discarded_at is not null))
);
create index outbox_drafts on outbox(organisation_id, created_at) where state = 'drafted';
alter table mail_triage enable row level security;
alter table mail_triage force row level security;
create policy mail_triage_tenant on mail_triage for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table attachment_text enable row level security;
alter table attachment_text force row level security;
create policy attachment_text_tenant on attachment_text for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table outbox enable row level security;
alter table outbox force row level security;
create policy outbox_read on outbox for select to app using (organisation_id = current_organisation_id());
create policy outbox_write on outbox for all to app
 using (organisation_id = current_organisation_id() and exists (select 1 from memberships m where m.organisation_id = outbox.organisation_id and m.user_id = current_user_id() and m.status = 'active'))
 with check (organisation_id = current_organisation_id() and exists (select 1 from memberships m where m.organisation_id = outbox.organisation_id and m.user_id = current_user_id() and m.status = 'active'));
grant select, insert, update, delete on mail_triage, attachment_text, outbox to app;
-- Only tenant identifiers escape RLS for housekeeping, including disconnected accounts.
create function attachment_text_organisations() returns table (organisation_id uuid)
 language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
 select distinct organisation_id from public.attachment_text where expires_at <= now()
 $$;
revoke all on function attachment_text_organisations() from public;
grant execute on function attachment_text_organisations() to app;
