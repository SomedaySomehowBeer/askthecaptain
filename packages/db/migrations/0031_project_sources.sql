-- Association (D22): which threads and notes belong to a project, and the names the triage model proposed
-- for ones that fit no project. Candidates become discovery seeds by threshold, never projects directly.
create table project_sources (
	organisation_id uuid not null references organisations(id) on delete cascade,
	project_id uuid not null,
	source_kind text not null check (source_kind in ('mail_thread', 'note')),
	source_id uuid not null,
	linked_by text not null check (linked_by in ('rule', 'model', 'person')),
	-- The run (rule or model) or the person that made the link; the rule's name when a rule did.
	linked_by_id uuid, rule text,
	-- The counterparty company at link time, so the company rule can read links without parsing headers.
	company_id uuid,
	created_at timestamptz not null default now(),
	primary key (organisation_id, project_id, source_kind, source_id),
	foreign key (organisation_id, project_id) references projects(organisation_id, id) on delete cascade,
	foreign key (organisation_id, company_id) references companies(organisation_id, id) on delete set null (company_id)
);
create index project_sources_source on project_sources (organisation_id, source_kind, source_id);
create index project_sources_company on project_sources (organisation_id, company_id) where company_id is not null;
alter table project_sources enable row level security; alter table project_sources force row level security;
create policy project_sources_tenant on project_sources for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
-- Sources cascade with the thread or note they point at (a polymorphic source carries no foreign key).
create function project_sources_cascade() returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
	delete from public.project_sources where organisation_id = old.organisation_id and source_kind = tg_argv[0] and source_id = old.id;
	delete from public.project_candidate_sources where organisation_id = old.organisation_id and source_kind = tg_argv[0] and source_id = old.id;
	return old;
end $$;
revoke all on function project_sources_cascade() from public;
create table project_candidates (
	organisation_id uuid not null references organisations(id) on delete cascade,
	normalised text not null check (length(normalised) between 1 and 200),
	name text not null check (length(name) between 1 and 200),
	stage text not null check (stage in ('idea', 'underway')),
	first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
	primary key (organisation_id, normalised)
);
alter table project_candidates enable row level security; alter table project_candidates force row level security;
create policy project_candidates_tenant on project_candidates for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
create table project_candidate_sources (
	organisation_id uuid not null references organisations(id) on delete cascade,
	normalised text not null,
	source_kind text not null check (source_kind in ('mail_thread', 'note')),
	source_id uuid not null,
	-- The person's own writing (a note or a sent message) counts differently in the thresholds (§6).
	own boolean not null default false,
	seen_at timestamptz not null default now(),
	primary key (organisation_id, normalised, source_kind, source_id),
	foreign key (organisation_id, normalised) references project_candidates(organisation_id, normalised) on delete cascade
);
alter table project_candidate_sources enable row level security; alter table project_candidate_sources force row level security;
create policy project_candidate_sources_tenant on project_candidate_sources for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
create trigger mail_threads_project_sources after delete on mail_threads for each row execute function project_sources_cascade('mail_thread');
create trigger notes_project_sources after delete on notes for each row execute function project_sources_cascade('note');
grant select, insert, update, delete on project_sources, project_candidates, project_candidate_sources to app;
