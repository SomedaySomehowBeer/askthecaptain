-- Discovery (D22): a project Captain proposes from evidence, the seeds a run works from, and candidates that close.
alter table projects add column proposed_at timestamptz;
alter table projects add column proposed_by uuid;
alter table projects add column accepted_at timestamptz;
alter table projects add column accepted_by uuid references users(id) on delete set null;
-- proposed · active · archived, derived so every reader agrees: a proposal is active only once a person accepts it.
alter table projects add column state text generated always as (case when archived_at is not null then 'archived' when proposed_at is not null and accepted_at is null then 'proposed' else 'active' end) stored;
create index projects_state on projects (organisation_id, state);
alter table project_candidates add column seeded_at timestamptz;
alter table project_candidates add column closed_at timestamptz;
-- A seed is what a discovery call starts from: a candidate name past its threshold, a thread or note a person chose,
-- suggested duties sharing a counterparty and a reference, or a cluster of the backlog on the first run.
create table discovery_seeds (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	kind text not null check (kind in ('candidate', 'thread', 'note', 'tasks', 'cluster')),
	key text not null check (length(key) between 1 and 400),
	reason text not null,
	name text,
	source_kind text check (source_kind in ('mail_thread', 'note')),
	source_id uuid,
	requested_by uuid references users(id) on delete set null,
	state text not null default 'pending' check (state in ('pending', 'running', 'done')),
	run_id uuid,
	outcome text check (outcome in ('project', 'task', 'relationship', 'nothing')),
	project_id uuid,
	created_at timestamptz not null default now(),
	finished_at timestamptz,
	unique (organisation_id, id),
	foreign key (organisation_id, project_id) references projects(organisation_id, id) on delete set null (project_id)
);
create unique index discovery_seeds_open on discovery_seeds (organisation_id, kind, key) where state in ('pending', 'running');
create index discovery_seeds_pending on discovery_seeds (organisation_id, created_at) where state = 'pending';
alter table discovery_seeds enable row level security; alter table discovery_seeds force row level security;
create policy discovery_seeds_tenant on discovery_seeds for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update, delete on discovery_seeds to app;
-- Evidence may be a note as well as mail (plan §2).
do $$ declare c text; begin
	select conname into c from pg_constraint where conrelid = 'evidence'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%';
	if c is not null then execute format('alter table evidence drop constraint %I', c); end if;
end $$;
alter table evidence add constraint evidence_kind_check check (kind in ('mail', 'note', 'file', 'url'));
