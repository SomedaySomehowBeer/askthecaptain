-- Job 6, D2/D4/D6: an infer result is saved by a separate, audited write step.
create table briefs (
 organisation_id uuid not null references organisations(id) on delete cascade,
 run_id uuid not null, for_date date not null, title text not null check (char_length(title) between 1 and 120),
 lines jsonb not null check (jsonb_typeof(lines) = 'array'),
 items jsonb not null check (jsonb_typeof(items) = 'array'), produced_at timestamptz not null default now(),
 primary key (organisation_id, run_id),
 foreign key (organisation_id, run_id) references workflow_runs(organisation_id, id) on delete cascade
);
create index briefs_latest on briefs(organisation_id, for_date desc, produced_at desc);
alter table briefs enable row level security;
alter table briefs force row level security;
create policy briefs_read on briefs for select to app using (organisation_id = current_organisation_id());
create policy briefs_write on briefs for all to app
 using (organisation_id = current_organisation_id() and exists (select 1 from memberships m where m.organisation_id = briefs.organisation_id and m.user_id = current_user_id() and m.status = 'active'))
 with check (organisation_id = current_organisation_id() and exists (select 1 from memberships m where m.organisation_id = briefs.organisation_id and m.user_id = current_user_id() and m.status = 'active'));
grant select, insert, update, delete on briefs to app;
