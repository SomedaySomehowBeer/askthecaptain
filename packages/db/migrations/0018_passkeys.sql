-- Passkeys (plan §9): a second factor at sign-in for anyone who has registered one, expected of
-- owners and admins before invitations open to strangers. Platform tables: a passkey belongs to a
-- person, not an organisation, and is reached only through the auth service.
create table passkeys (
	id uuid primary key default uuidv7(),
	user_id uuid not null references users(id) on delete cascade,
	credential_id text not null unique,
	public_key bytea not null,
	counter bigint not null default 0,
	transports text[] not null default '{}',
	device_type text not null default 'singleDevice',
	backed_up boolean not null default false,
	name text not null default 'Passkey',
	created_at timestamptz not null default now(),
	last_used_at timestamptz
);
create index passkeys_user_id_idx on passkeys (user_id);

-- A session says whether a passkey was presented when it was issued.
alter table sessions add column passkey_verified_at timestamptz;

-- Challenges for registration and step-up live with the other short-lived sign-in secrets.
alter table auth_requests drop constraint auth_requests_kind_check;
alter table auth_requests add constraint auth_requests_kind_check
	check (kind in ('oauth', 'session_exchange', 'google_connection', 'xero_connection', 'xero_selection', 'passkey_challenge'));

grant select, insert, update, delete on passkeys to app;
