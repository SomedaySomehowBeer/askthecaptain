-- D6, D8, D16: tenant-isolated connections; only wrapped keys and encrypted tokens.
alter table organisations add column data_key_wrapped bytea;
alter table auth_requests drop constraint auth_requests_kind_check;
alter table auth_requests add constraint auth_requests_kind_check check (kind in ('oauth', 'session_exchange', 'google_connection'));

create table connections (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	provider text not null,
	connected_by uuid not null,
	account_email text not null,
	scopes text[] not null,
	status text not null check (status in ('connected', 'refresh_failed', 'revoked', 'disconnected')),
	error text,
	access_token_encrypted bytea,
	refresh_token_encrypted bytea,
	access_token_expires_at timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (organisation_id, provider),
	unique (organisation_id, id),
	foreign key (organisation_id, connected_by) references memberships(organisation_id, user_id)
);
create table sync_cursors (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	connection_id uuid not null,
	resource text not null,
	cursor text not null,
	updated_at timestamptz not null default now(),
	unique (organisation_id, connection_id, resource),
	foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade
);
create table webhook_events (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	connection_id uuid not null,
	provider text not null,
	provider_event_id text not null,
	payload jsonb not null,
	received_at timestamptz not null default now(),
	processed_at timestamptz,
	unique (provider, provider_event_id),
	unique (organisation_id, connection_id, id),
	foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade
);
create table webhook_attempts (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	connection_id uuid not null,
	webhook_event_id uuid not null,
	attempted_at timestamptz not null default now(),
	completed_at timestamptz,
	error text,
	foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade,
	foreign key (organisation_id, connection_id, webhook_event_id) references webhook_events(organisation_id, connection_id, id) on delete cascade
);

alter table connections enable row level security;
alter table connections force row level security;
create policy connections_tenant on connections for all to app
	using (organisation_id = current_organisation_id())
	with check (organisation_id = current_organisation_id());
alter table sync_cursors enable row level security;
alter table sync_cursors force row level security;
create policy sync_cursors_tenant on sync_cursors for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table webhook_events enable row level security;
alter table webhook_events force row level security;
create policy webhook_events_tenant on webhook_events for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table webhook_attempts enable row level security;
alter table webhook_attempts force row level security;
create policy webhook_attempts_tenant on webhook_attempts for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update on connections to app;
grant select, insert, update, delete on sync_cursors, webhook_events, webhook_attempts to app;
