-- Notifications (plan §5 "Notifications", §6 notify steps): a person's devices subscribed to Web
-- Push, and the record of every push sent to them. A subscription belongs to a member of the
-- organisation; a delivery is journaled whether it succeeded or not.
create table push_subscriptions (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	user_id uuid not null,
	endpoint text not null,
	p256dh text not null,
	auth text not null,
	user_agent text not null default '',
	created_at timestamptz not null default now(),
	last_used_at timestamptz,
	-- Set when the push service said the subscription is gone (404/410) or a person removed it.
	disabled_at timestamptz,
	disabled_reason text,
	unique (organisation_id, endpoint),
	unique (organisation_id, id),
	foreign key (organisation_id, user_id) references memberships(organisation_id, user_id) on delete cascade
);
create index push_subscriptions_user on push_subscriptions (organisation_id, user_id) where disabled_at is null;

create table push_deliveries (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	subscription_id uuid not null,
	run_id uuid,
	title text not null,
	body text not null default '',
	url text not null default '/',
	state text not null check (state in ('sent', 'failed', 'gone')),
	status_code integer,
	error text,
	created_at timestamptz not null default now(),
	foreign key (organisation_id, subscription_id) references push_subscriptions(organisation_id, id) on delete cascade,
	foreign key (organisation_id, run_id) references workflow_runs(organisation_id, id) on delete set null (run_id)
);
create index push_deliveries_recent on push_deliveries (organisation_id, created_at desc);

alter table push_subscriptions enable row level security;
alter table push_subscriptions force row level security;
create policy push_subscriptions_tenant on push_subscriptions for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
alter table push_deliveries enable row level security;
alter table push_deliveries force row level security;
create policy push_deliveries_tenant on push_deliveries for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update, delete on push_subscriptions to app;
grant select, insert on push_deliveries to app;
