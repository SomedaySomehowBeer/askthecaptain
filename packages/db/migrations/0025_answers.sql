-- Job 6, D2/D6: independent questions with saved, validated source references; never chat state.
create table answers (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 asked_by uuid not null,
 question text not null check (char_length(trim(question)) between 1 and 1000),
 answer text not null check (char_length(trim(answer)) between 1 and 2000),
 sources jsonb not null check (jsonb_typeof(sources) = 'array'),
 confidence text not null check (confidence in ('from_data', 'partly', 'not_in_data')),
 model text not null, created_at timestamptz not null default now(),
 unique (organisation_id, id),
 foreign key (organisation_id, asked_by) references memberships(organisation_id, user_id) on delete cascade
);
create index answers_recent on answers(organisation_id, asked_by, created_at desc, id desc);
alter table answers enable row level security;
alter table answers force row level security;
create policy answers_read on answers for select to app using (
 organisation_id = current_organisation_id() and exists (select 1 from memberships m where m.organisation_id = answers.organisation_id and m.user_id = current_user_id() and m.status = 'active'));
create policy answers_write on answers for insert to app with check (
 organisation_id = current_organisation_id() and asked_by = current_user_id() and exists (select 1 from memberships m where m.organisation_id = answers.organisation_id and m.user_id = current_user_id() and m.status = 'active'));
-- Exchanges are append-only; owners/admins export them with the rest of the organisation's data.
grant select, insert on answers to app;
