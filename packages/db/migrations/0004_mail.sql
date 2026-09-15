-- D6/D13: mail content, attachment metadata only, and tenant-carrying foreign keys.
create table mail_threads (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	connection_id uuid not null,
	account_email text not null,
	provider_id text not null,
	label_ids text[] not null default '{}',
	label_names text[] not null default '{}',
	last_message_at timestamptz not null,
	updated_at timestamptz not null default now(),
	unique (organisation_id, connection_id, provider_id),
	unique (organisation_id, connection_id, id),
	foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade
);
create index mail_threads_newest on mail_threads (organisation_id, last_message_at desc, id);
create table mail_messages (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	connection_id uuid not null,
	thread_id uuid not null,
	provider_id text not null,
	from_header text not null,
	to_header text not null,
	cc_header text not null,
	subject text not null,
	date_header text not null,
	sent_at timestamptz not null,
	snippet text not null,
	label_ids text[] not null default '{}',
	in_reply_to text not null,
	body text not null,
	body_unavailable boolean not null default false,
	unique (organisation_id, connection_id, provider_id),
	unique (organisation_id, id),
	foreign key (organisation_id, connection_id, thread_id) references mail_threads(organisation_id, connection_id, id) on delete cascade
);
create index mail_messages_thread on mail_messages (organisation_id, thread_id, sent_at);
create table mail_attachments (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	message_id uuid not null,
	part_id text not null,
	filename text not null,
	media_type text not null,
	size integer not null check (size >= 0),
	provider_attachment_id text,
	unique (organisation_id, message_id, part_id),
	foreign key (organisation_id, message_id) references mail_messages(organisation_id, id) on delete cascade
);
alter table mail_threads enable row level security;
alter table mail_threads force row level security;
create policy mail_threads_tenant on mail_threads for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table mail_messages enable row level security;
alter table mail_messages force row level security;
create policy mail_messages_tenant on mail_messages for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table mail_attachments enable row level security;
alter table mail_attachments force row level security;
create policy mail_attachments_tenant on mail_attachments for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update, delete on mail_threads, mail_messages, mail_attachments to app;

-- Narrow discovery for the in-process system scheduler. It returns tenant IDs only, never tokens
-- or mail. All subsequent work uses withTenant and the non-bypassing app role.
create function gmail_sync_organisations() returns table (organisation_id uuid)
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
		select organisation_id from public.connections where provider = 'google' and status = 'connected'
	$$;
revoke all on function gmail_sync_organisations() from public;
grant execute on function gmail_sync_organisations() to app;
