-- Workflows (plan §5 "Workflows", §6, D3, D4): the code-defined catalogue the API exposes, what each
-- organisation has enabled and with which parameters, and the journal of runs and their steps.

-- Platform table: the catalogue is the same for every organisation and is synced from the code at
-- API start. No organisation_id, no RLS; the runtime role may read and upsert it.
create table workflow_definitions (
	key text primary key,
	version integer not null,
	name text not null,
	description text not null,
	job smallint not null check (job between 1 and 6),
	triggers jsonb not null,
	parameters jsonb not null,
	steps jsonb not null,
	requirements text[] not null default '{}',
	digest text not null,
	updated_at timestamptz not null default now()
);

create table workflow_enablements (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	definition_key text not null references workflow_definitions(key),
	definition_version integer not null,
	enabled boolean not null default false,
	-- The person in whose name the workflow acts (D4).
	enabled_by uuid references users(id) on delete set null,
	parameters jsonb not null default '{}'::jsonb,
	schedule_overrides jsonb not null default '{}'::jsonb,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (organisation_id, definition_key),
	unique (organisation_id, id)
);

create table workflow_runs (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	enablement_id uuid not null,
	definition_key text not null,
	definition_version integer not null,
	definition_digest text not null,
	trigger jsonb not null,
	state text not null default 'queued' check (state in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'paused', 'cancelled')),
	-- Why a run is paused or failed, in words a person can act on.
	reason text,
	started_at timestamptz,
	finished_at timestamptz,
	created_at timestamptz not null default now(),
	unique (organisation_id, id),
	foreign key (organisation_id, enablement_id) references workflow_enablements(organisation_id, id) on delete cascade
);
create index workflow_runs_recent on workflow_runs (organisation_id, created_at desc);

create table workflow_run_steps (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	run_id uuid not null,
	-- Where in the definition: "steps.1.steps.3" for the fourth step of the loop at index 1, plus
	-- the item index inside an each.
	path text not null,
	item_index integer,
	kind text not null check (kind in ('read', 'infer', 'write', 'await', 'notify')),
	key text not null,
	state text not null default 'pending' check (state in ('pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped')),
	input_digest text,
	output jsonb,
	error text,
	started_at timestamptz,
	finished_at timestamptz,
	foreign key (organisation_id, run_id) references workflow_runs(organisation_id, id) on delete cascade
);
create index workflow_run_steps_run on workflow_run_steps (organisation_id, run_id, started_at);

alter table workflow_enablements enable row level security;
alter table workflow_enablements force row level security;
create policy workflow_enablements_tenant on workflow_enablements for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table workflow_runs enable row level security;
alter table workflow_runs force row level security;
create policy workflow_runs_tenant on workflow_runs for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table workflow_run_steps enable row level security;
alter table workflow_run_steps force row level security;
create policy workflow_run_steps_tenant on workflow_run_steps for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());

grant select, insert, update on workflow_definitions to app;
grant select, insert, update, delete on workflow_enablements, workflow_runs, workflow_run_steps to app;
