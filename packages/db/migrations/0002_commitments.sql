-- Commitments (plan §5, D7): projects, tasks, the series that generate recurring tasks, and the
-- evidence attached to a task. One system project per organisation, Obligations, is the deadline
-- book; the API creates it the first time an organisation's commitments are read or written.

create table projects (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	name text not null,
	description text not null default '',
	stages text[] not null default '{}',
	owner_id uuid references users(id) on delete set null,
	-- The one flagged system project. Null for every ordinary project.
	system_kind text check (system_kind in ('obligations')),
	archived_at timestamptz,
	created_by uuid references users(id) on delete set null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	-- Referenced together with organisation_id by child tables: a foreign key check bypasses row
	-- security, so a plain reference to `id` would let a tenant point at another tenant's row.
	unique (organisation_id, id)
);
create index projects_organisation_id_idx on projects (organisation_id, archived_at, name);
create unique index projects_one_system_per_kind on projects (organisation_id, system_kind) where system_kind is not null;

create table task_series (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	project_id uuid not null,
	-- Template for each occurrence. `{period}` in the title becomes the period's label.
	title text not null,
	body text not null default '',
	owner_id uuid references users(id) on delete set null,
	evidence_required boolean not null default false,
	-- The period each occurrence covers, and when the occurrence is due relative to that period's
	-- last day (21 for "due 21 days after the period ends"; negative for before it ends).
	recurrence text not null check (recurrence in ('monthly', 'quarterly', 'yearly', 'weekdays', 'custom')),
	every_months integer check (every_months is null or every_months between 1 and 120),
	anchor date not null,
	due_offset_days integer not null default 0,
	paused_at timestamptz,
	created_by uuid references users(id) on delete set null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	check ((recurrence = 'custom') = (every_months is not null)),
	unique (organisation_id, id),
	foreign key (organisation_id, project_id) references projects(organisation_id, id) on delete cascade
);
create index task_series_organisation_id_idx on task_series (organisation_id, project_id);

create table tasks (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	project_id uuid not null,
	title text not null,
	body text not null default '',
	status text not null default 'open' check (status in ('suggested', 'open', 'in_progress', 'done', 'cancelled')),
	owner_id uuid references users(id) on delete set null,
	due date,
	-- Where the task came from: a person, a mail thread, a series occurrence or a workflow run.
	source_kind text not null default 'person' check (source_kind in ('person', 'mail', 'series', 'run')),
	source_id text,
	series_id uuid,
	period_start date,
	period_end date,
	completed_by uuid references users(id) on delete set null,
	completed_at timestamptz,
	created_by uuid references users(id) on delete set null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	check ((series_id is null) or (period_start is not null and period_end is not null)),
	unique (organisation_id, id),
	foreign key (organisation_id, project_id) references projects(organisation_id, id) on delete cascade,
	foreign key (organisation_id, series_id) references task_series(organisation_id, id) on delete set null (series_id)
);
create index tasks_organisation_id_idx on tasks (organisation_id, project_id, status, due);
create index tasks_due_idx on tasks (organisation_id, due) where status in ('open', 'in_progress');
-- A series produces one task per period; materialising twice is a no-op.
create unique index tasks_one_per_series_period on tasks (series_id, period_start) where series_id is not null;

create table evidence (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	task_id uuid not null,
	kind text not null check (kind in ('mail', 'file', 'url')),
	reference text not null,
	label text not null default '',
	attached_by uuid references users(id) on delete set null,
	attached_at timestamptz not null default now(),
	foreign key (organisation_id, task_id) references tasks(organisation_id, id) on delete cascade
);
create index evidence_task_id_idx on evidence (organisation_id, task_id);

alter table projects enable row level security;
alter table projects force row level security;
create policy projects_tenant on projects for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());

alter table task_series enable row level security;
alter table task_series force row level security;
create policy task_series_tenant on task_series for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());

alter table tasks enable row level security;
alter table tasks force row level security;
create policy tasks_tenant on tasks for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());

alter table evidence enable row level security;
alter table evidence force row level security;
create policy evidence_tenant on evidence for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());

grant select, insert, update, delete on projects, task_series, tasks, evidence to app;
