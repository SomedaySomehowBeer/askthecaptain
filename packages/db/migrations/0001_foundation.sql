-- Foundation: organisations, people, sessions, memberships, invitations, audit.
-- Tenant tables carry organisation_id and forced Row Level Security for the runtime role `app`.
-- Platform tables (users, identities, sessions, auth_requests, auth_events) hold no tenant data and
-- are reached only through the auth service.

do $$ begin
	if not exists (select 1 from pg_roles where rolname = 'app') then create role app nologin; end if;
end $$;

create table organisations (
	id uuid primary key default uuidv7(),
	name text not null,
	timezone text not null default 'Australia/Perth',
	locale text not null default 'en-AU',
	settings jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now()
);

create table users (
	id uuid primary key default uuidv7(),
	email text not null unique,
	name text not null default '',
	created_at timestamptz not null default now()
);

create table identities (
	id uuid primary key default uuidv7(),
	user_id uuid not null references users(id) on delete cascade,
	provider text not null,
	subject text not null,
	email text not null,
	created_at timestamptz not null default now(),
	unique (provider, subject)
);

create table sessions (
	id uuid primary key default uuidv7(),
	user_id uuid not null references users(id) on delete cascade,
	token_hash text not null unique,
	expires_at timestamptz not null,
	revoked_at timestamptz,
	created_at timestamptz not null default now()
);
create index sessions_user_id_idx on sessions (user_id);

-- Short-lived, single-use secrets for sign-in flows: an OAuth state with its PKCE verifier and
-- nonce, or a session exchange code handed from the API to the web.
create table auth_requests (
	id uuid primary key default uuidv7(),
	kind text not null check (kind in ('oauth', 'session_exchange')),
	token_hash text not null unique,
	user_id uuid references users(id) on delete cascade,
	payload jsonb not null default '{}'::jsonb,
	expires_at timestamptz not null,
	consumed_at timestamptz,
	created_at timestamptz not null default now()
);
create index auth_requests_expires_at_idx on auth_requests (expires_at);

-- Sign-in outcomes have no organisation yet; they are platform records.
create table auth_events (
	id uuid primary key default uuidv7(),
	event text not null,
	success boolean not null,
	request_id text not null,
	user_id uuid,
	detail jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now()
);

create table memberships (
	organisation_id uuid not null references organisations(id) on delete cascade,
	user_id uuid not null references users(id) on delete cascade,
	role text not null check (role in ('owner', 'admin', 'member')),
	status text not null default 'active' check (status in ('active', 'removed')),
	created_at timestamptz not null default now(),
	primary key (organisation_id, user_id)
);
create index memberships_user_id_idx on memberships (user_id);

create table invitations (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	email text not null,
	role text not null check (role in ('admin', 'member')),
	token_hash text not null unique,
	invited_by uuid not null,
	expires_at timestamptz not null,
	accepted_at timestamptz,
	revoked_at timestamptz,
	created_at timestamptz not null default now(),
	foreign key (organisation_id, invited_by) references memberships(organisation_id, user_id)
);
create index invitations_organisation_id_idx on invitations (organisation_id);

create table audit_events (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	actor_kind text not null check (actor_kind in ('person', 'workflow', 'system')),
	actor_id uuid,
	action text not null,
	subject_type text not null,
	subject_id text,
	request_id text,
	detail jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now()
);
create index audit_events_organisation_id_created_at_idx on audit_events (organisation_id, created_at desc);

-- Tenant context is set per transaction by the application (set_config with is_local = true).
create function current_organisation_id() returns uuid
	language sql stable as $$ select nullif(current_setting('app.organisation_id', true), '')::uuid $$;
create function current_user_id() returns uuid
	language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

alter table organisations enable row level security;
alter table organisations force row level security;
create policy organisations_tenant on organisations for all to app
	using (id = current_organisation_id()
		or exists (select 1 from memberships m where m.organisation_id = organisations.id and m.user_id = current_user_id() and m.status = 'active'))
	with check (id = current_organisation_id());

alter table memberships enable row level security;
alter table memberships force row level security;
create policy memberships_tenant on memberships for all to app
	using (organisation_id = current_organisation_id() or user_id = current_user_id())
	with check (organisation_id = current_organisation_id());

alter table invitations enable row level security;
alter table invitations force row level security;
create policy invitations_tenant on invitations for all to app
	using (organisation_id = current_organisation_id())
	with check (organisation_id = current_organisation_id());

alter table audit_events enable row level security;
alter table audit_events force row level security;
create policy audit_events_tenant on audit_events for all to app
	using (organisation_id = current_organisation_id())
	with check (organisation_id = current_organisation_id());
-- The audit log is append-only for the runtime role.
revoke update, delete on audit_events from app;

grant usage on schema public to app;
grant select, insert, update, delete on organisations, memberships, invitations to app;
grant select, insert on audit_events to app;
grant select, insert, update, delete on users, identities, sessions, auth_requests to app;
grant select, insert on auth_events to app;
grant execute on function current_organisation_id(), current_user_id() to app;
