-- Notes are first-class content (D23): plain text a person writes in Captain, linked to at most one event,
-- contact, company, project and task; triaged like mail with the person as author, so nothing needs the owner.
alter table calendar_events add unique (organisation_id, id);
create table notes (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	author_id uuid not null references users(id),
	title text not null default '' check (length(title) <= 300),
	body text not null check (length(body) between 1 and 20000),
	event_id uuid, contact_id uuid, company_id uuid, project_id uuid, task_id uuid,
	archived_at timestamptz,
	created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
	unique (organisation_id, id),
	foreign key (organisation_id, event_id) references calendar_events(organisation_id, id) on delete set null (event_id),
	foreign key (organisation_id, contact_id) references contacts(organisation_id, id) on delete set null (contact_id),
	foreign key (organisation_id, company_id) references companies(organisation_id, id) on delete set null (company_id),
	foreign key (organisation_id, project_id) references projects(organisation_id, id) on delete set null (project_id),
	foreign key (organisation_id, task_id) references tasks(organisation_id, id) on delete set null (task_id)
);
create index notes_recent on notes (organisation_id, updated_at desc) where archived_at is null;
alter table notes enable row level security; alter table notes force row level security;
create policy notes_tenant on notes for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
-- One row per note, the shape of mail_triage less the needs-owner flag. The digest and length say which text was read,
-- so a note is classified again only after an edit beyond a trivial change.
create table note_triage (
	organisation_id uuid not null references organisations(id) on delete cascade,
	note_id uuid not null, category text not null, summary text not null, facts jsonb not null,
	produced_by uuid not null, model text not null, body_digest text not null, body_length integer not null,
	created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
	primary key (organisation_id, note_id),
	foreign key (organisation_id, note_id) references notes(organisation_id, id) on delete cascade,
	foreign key (organisation_id, produced_by) references workflow_runs(organisation_id, id) on delete cascade
);
alter table note_triage enable row level security; alter table note_triage force row level security;
create policy note_triage_tenant on note_triage for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
-- A suggested task can come from a note.
alter table tasks drop constraint tasks_source_kind_check;
alter table tasks add constraint tasks_source_kind_check check (source_kind in ('person', 'mail', 'series', 'run', 'note'));

grant select, insert, update, delete on notes, note_triage to app;
