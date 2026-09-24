-- D24: exclusive equipment occupancy, enforced even for concurrent transactions.
create extension if not exists btree_gist;
create table equipment (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 name text not null check (name = btrim(name) and length(name) between 1 and 100),
 archived_at timestamptz,
 revision integer not null default 1 check (revision > 0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (organisation_id, id)
);
create unique index equipment_name on equipment (organisation_id, lower(name));
create table equipment_reservations (
 id uuid primary key,
 organisation_id uuid not null references organisations(id) on delete cascade,
 equipment_id uuid not null,
 title text not null check (title = btrim(title) and length(title) between 1 and 200),
 kind text not null default 'booking' check (kind in ('booking', 'maintenance')),
 status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 setup_minutes integer not null default 0 check (setup_minutes between 0 and 10080),
 cleanup_minutes integer not null default 0 check (cleanup_minutes between 0 and 10080),
 occupied_starts_at timestamptz not null,
 occupied_ends_at timestamptz not null,
 project_id uuid,
 task_id uuid,
 owner_id uuid,
 created_by uuid not null,
 revision integer not null default 1 check (revision > 0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (organisation_id, id),
 foreign key (organisation_id, equipment_id) references equipment(organisation_id, id),
 foreign key (organisation_id, project_id) references projects(organisation_id, id),
 foreign key (organisation_id, task_id) references tasks(organisation_id, id),
 foreign key (organisation_id, owner_id) references memberships(organisation_id, user_id),
 foreign key (organisation_id, created_by) references memberships(organisation_id, user_id),
 check (task_id is null or project_id is not null),
 check (isfinite(starts_at) and isfinite(ends_at) and starts_at >= '1900-01-01T00:00:00Z' and ends_at < '2200-01-01T00:00:00Z'),
 check (ends_at > starts_at and extract(epoch from ends_at - starts_at) <= 31622400),
 check (occupied_starts_at = starts_at - setup_minutes * interval '1 minute'),
 check (occupied_ends_at = ends_at + cleanup_minutes * interval '1 minute'),
 constraint equipment_reservations_no_overlap exclude using gist
  (organisation_id with =, equipment_id with =, tstzrange(occupied_starts_at, occupied_ends_at, '[)') with &&)
  where (status = 'confirmed')
);
create index equipment_reservations_by_time on equipment_reservations (organisation_id, equipment_id, occupied_starts_at, id);
alter table equipment enable row level security;
alter table equipment force row level security;
create policy equipment_member on equipment for all to app
 using (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = equipment.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'))
 with check (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = equipment.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'));
alter table equipment_reservations enable row level security;
alter table equipment_reservations force row level security;
create policy equipment_reservations_read on equipment_reservations for select to app
 using (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = equipment_reservations.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'));
create policy equipment_reservations_insert on equipment_reservations for insert to app
 with check (organisation_id = current_organisation_id() and created_by = current_user_id() and exists (
  select 1 from memberships m where m.organisation_id = equipment_reservations.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'));
create policy equipment_reservations_update on equipment_reservations for update to app
 using (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = equipment_reservations.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'))
 with check (organisation_id = current_organisation_id() and exists (
  select 1 from memberships m where m.organisation_id = equipment_reservations.organisation_id
   and m.user_id = current_user_id() and m.status = 'active'));
grant select, insert, update on equipment, equipment_reservations to app;
