-- Throwaway spike fixtures, NOT a production mail/outbox migration (issue #18 owns those).
create schema engine_spike;
create table engine_spike.outbox (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id), run_id uuid not null,
 thread_id text not null, body text not null, idempotency_key text, state text not null default 'drafted',
 unique (organisation_id, idempotency_key), unique (organisation_id, id),
 foreign key (organisation_id, run_id) references workflow_runs(organisation_id, id)
);
create table engine_spike.labels (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id), run_id uuid not null,
 thread_id text not null, idempotency_key text, unique (organisation_id, idempotency_key),
 foreign key (organisation_id, run_id) references workflow_runs(organisation_id, id)
);
create table engine_spike.faults (
 organisation_id uuid not null references organisations(id), run_id uuid not null, key text not null,
 primary key (organisation_id, run_id, key), foreign key (organisation_id, run_id) references workflow_runs(organisation_id, id)
);
alter table engine_spike.outbox enable row level security;
alter table engine_spike.outbox force row level security;
create policy tenant on engine_spike.outbox for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table engine_spike.labels enable row level security;
alter table engine_spike.labels force row level security;
create policy tenant on engine_spike.labels for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table engine_spike.faults enable row level security;
alter table engine_spike.faults force row level security;
create policy tenant on engine_spike.faults for all to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant usage on schema engine_spike to app;
grant select, insert, update on all tables in schema engine_spike to app;
