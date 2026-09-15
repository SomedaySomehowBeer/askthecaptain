-- Organisation deletion as a first-class operation (plan §9). Every tenant row cascades from the
-- organisation, including its audit log, so the fact of the deletion is kept here: a platform
-- record with no tenant data beyond the name, who did it, and how many rows went with it.
create table organisation_deletions (
	id uuid primary key default uuidv7(),
	-- Not `organisation_id`: this is a platform row about an organisation that no longer exists.
	deleted_organisation_id uuid not null,
	name text not null,
	deleted_by uuid references users(id) on delete set null,
	deleted_by_email text not null,
	row_counts jsonb not null default '{}'::jsonb,
	deleted_at timestamptz not null default now()
);
grant select, insert on organisation_deletions to app;
