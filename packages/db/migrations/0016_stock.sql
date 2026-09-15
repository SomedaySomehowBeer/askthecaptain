-- D15: observations, never movements. Tenant-qualified references also guard FK checks that bypass RLS.
create table stock_items (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 name text not null check (length(trim(name)) > 0), location text not null check (length(trim(location)) > 0),
 unit_label text not null check (length(trim(unit_label)) > 0),
 current_count numeric check (current_count >= 0 and current_count < 'Infinity'::numeric),
 counted_at timestamptz, counted_by uuid,
 reorder_point numeric check (reorder_point >= 0 and reorder_point < 'Infinity'::numeric),
 preferred_supplier_id uuid, notes text not null default '', archived_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (organisation_id, id), unique (organisation_id, location, name),
 foreign key (organisation_id, counted_by) references memberships(organisation_id, user_id),
 foreign key (organisation_id, preferred_supplier_id) references companies(organisation_id, id),
 check ((current_count is null and counted_at is null and counted_by is null)
  or (current_count is not null and counted_at is not null and counted_by is not null))
);
create table stock_counts (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 item_id uuid not null, counted_at timestamptz not null default clock_timestamp(), counted_by uuid not null,
 count numeric not null check (count >= 0 and count < 'Infinity'::numeric), note text not null default '',
 unique (organisation_id, id),
 foreign key (organisation_id, item_id) references stock_items(organisation_id, id),
 foreign key (organisation_id, counted_by) references memberships(organisation_id, user_id)
);
create index stock_counts_item on stock_counts (organisation_id, item_id, counted_at desc, id desc);
alter table stock_items enable row level security;
alter table stock_items force row level security;
create policy stock_items_tenant on stock_items for all to app
 using (organisation_id = current_organisation_id())
 with check (organisation_id = current_organisation_id() and exists (
  select 1 from memberships where organisation_id = current_organisation_id() and user_id = current_user_id() and status = 'active'));
alter table stock_counts enable row level security;
alter table stock_counts force row level security;
create policy stock_counts_read on stock_counts for select to app using (organisation_id = current_organisation_id());
create policy stock_counts_insert on stock_counts for insert to app
 with check (organisation_id = current_organisation_id() and counted_by = current_user_id() and exists (
  select 1 from memberships where organisation_id = current_organisation_id() and user_id = current_user_id() and status = 'active'));
grant select, insert, update on stock_items to app;
grant select, insert on stock_counts to app;
