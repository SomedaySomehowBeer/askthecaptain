-- Own writing (plan §14): a sent message with enough of the person's own text is classified like a note, for tasks,
-- facts and a project name; never for needs-owner, never drafted. The cursor walks sent messages in insertion order.
alter table workflow_enablements add column sent_cursor uuid;
create table sent_triage (
	organisation_id uuid not null references organisations(id) on delete cascade,
	message_id uuid not null, thread_id uuid not null,
	category text not null, summary text not null, facts jsonb not null,
	produced_by uuid not null, model text not null,
	created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
	primary key (organisation_id, message_id),
	foreign key (organisation_id, message_id) references mail_messages(organisation_id, id) on delete cascade,
	foreign key (organisation_id, produced_by) references workflow_runs(organisation_id, id) on delete cascade
);
alter table sent_triage enable row level security; alter table sent_triage force row level security;
create policy sent_triage_tenant on sent_triage for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update, delete on sent_triage to app;
