-- D6: tenant-carrying foreign keys also protect writes when PostgreSQL bypasses RLS for FK checks.
create table calendars (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 connection_id uuid not null,
 account_email text not null,
 provider_id text not null,
 name text not null,
 is_primary boolean not null default false,
 timezone text not null,
 access_role text not null,
 selected boolean not null default false,
 synced_from timestamptz,
 synced_to timestamptz,
 synced_at timestamptz,
 unique (organisation_id, connection_id, provider_id),
 unique (organisation_id, id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade
);
create table calendar_events (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 calendar_id uuid not null,
 provider_id text not null,
 status text not null check (status in ('confirmed', 'tentative')),
 summary text not null,
 description text not null,
 location text not null,
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 all_day boolean not null,
 start_date date,
 end_date date,
 timezone text not null,
 organiser jsonb not null,
 attendees jsonb not null check (jsonb_typeof(attendees) = 'array'),
 attendees_omitted boolean not null default false,
 recurring_event_id text,
 html_link text not null,
 updated_at timestamptz not null,
 unique (organisation_id, calendar_id, provider_id),
 foreign key (organisation_id, calendar_id) references calendars(organisation_id, id) on delete cascade,
 check (ends_at > starts_at),
 check ((all_day and start_date is not null and end_date is not null and end_date > start_date) or (not all_day and start_date is null and end_date is null))
);
create index calendar_events_range on calendar_events (organisation_id, starts_at, ends_at);
alter table calendars enable row level security;
alter table calendars force row level security;
create policy calendars_tenant on calendars for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table calendar_events enable row level security;
alter table calendar_events force row level security;
create policy calendar_events_tenant on calendar_events for all to app
 using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update, delete on calendars, calendar_events to app;
-- Scheduler discovery exposes only ids, never connection contents.
create function calendar_sync_organisations() returns table (organisation_id uuid)
 language sql security definer set search_path = pg_catalog, public, pg_temp as $$
 select c.organisation_id from public.connections c where c.provider = 'google' and c.status = 'connected'
$$;
revoke all on function calendar_sync_organisations() from public;
grant execute on function calendar_sync_organisations() to app;
