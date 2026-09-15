-- D6/D8/D15/D16: provider-owned quantities, separate person-owned reorder points.
alter table auth_requests drop constraint auth_requests_kind_check;
alter table auth_requests add check (kind in ('oauth', 'session_exchange', 'google_connection', 'xero_connection', 'xero_selection', 'passkey_challenge', 'shopify_connection'));
create table shopify_products (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 connection_id uuid not null, provider_id text not null, product_provider_id text not null, title text not null, variant_title text not null,
 sku text, price numeric not null check (price >= 0 and price < 'Infinity'::numeric), product_status text not null,
 inventory_item_id text not null, tracked boolean not null, seen_run uuid not null,
 unique (organisation_id, connection_id, provider_id), unique (organisation_id, connection_id, inventory_item_id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade
);
create table shopify_inventory_levels (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 connection_id uuid not null, inventory_item_id text not null, location_provider_id text not null, location_name text not null,
 available integer not null, updated_at timestamptz not null, seen_run uuid not null,
 unique (organisation_id, connection_id, inventory_item_id, location_provider_id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade,
 foreign key (organisation_id, connection_id, inventory_item_id) references shopify_products(organisation_id, connection_id, inventory_item_id) on delete cascade
);
create table shopify_orders (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 connection_id uuid not null, provider_id text not null, number text not null, customer_name text, customer_email text,
 financial_status text, fulfilment_status text not null, cancelled_at timestamptz,
 total numeric not null check (total >= 0 and total < 'Infinity'::numeric), currency text not null,
 created_at timestamptz not null, updated_at timestamptz not null, seen_run uuid,
 unique (organisation_id, connection_id, provider_id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade
);
create table shopify_reorder_points (
 id uuid primary key default uuidv7(), organisation_id uuid not null references organisations(id) on delete cascade,
 connection_id uuid not null, variant_provider_id text not null, reorder_point numeric not null check (reorder_point >= 0 and reorder_point < 'Infinity'::numeric),
 updated_at timestamptz not null default now(),
 unique (organisation_id, connection_id, variant_provider_id),
 foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade,
 foreign key (organisation_id, connection_id, variant_provider_id) references shopify_products(organisation_id, connection_id, provider_id) on delete cascade
);
alter table shopify_products enable row level security;
alter table shopify_products force row level security;
create policy shopify_products_tenant on shopify_products to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table shopify_inventory_levels enable row level security;
alter table shopify_inventory_levels force row level security;
create policy shopify_inventory_levels_tenant on shopify_inventory_levels to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table shopify_orders enable row level security;
alter table shopify_orders force row level security;
create policy shopify_orders_tenant on shopify_orders to app using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table shopify_reorder_points enable row level security;
alter table shopify_reorder_points force row level security;
create policy shopify_reorder_points_read on shopify_reorder_points for select to app using (organisation_id = current_organisation_id());
create policy shopify_reorder_points_write on shopify_reorder_points for all to app
 using (organisation_id = current_organisation_id() and exists (select 1 from memberships where organisation_id = current_organisation_id() and user_id = current_user_id() and status = 'active'))
 with check (organisation_id = current_organisation_id() and exists (select 1 from memberships where organisation_id = current_organisation_id() and user_id = current_user_id() and status = 'active'));
grant select, insert, update, delete on shopify_products, shopify_inventory_levels, shopify_orders, shopify_reorder_points to app;
create function shopify_sync_organisations() returns table (organisation_id uuid)
 language sql security definer set search_path = pg_catalog, public, pg_temp as $$
 select c.organisation_id from public.connections c where c.provider = 'shopify' and c.status = 'connected' and c.provider_account_id is not null
$$;
revoke all on function shopify_sync_organisations() from public;
grant execute on function shopify_sync_organisations() to app;
