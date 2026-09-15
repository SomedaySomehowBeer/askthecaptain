-- D2, D6, D9, D16, D18: subscription runtimes and token accounting.
create table inference_runtimes (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 provider text not null check (provider in ('claude', 'codex', 'anthropic_api')),
 sprite_name text, region text,
 status text not null check (status in ('provisioning', 'needs_login', 'ready', 'failed', 'removed')),
 login_hint text, login_url text, added_by uuid not null,
 connection_encrypted bytea, last_verified_at timestamptz, error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique (organisation_id), unique (organisation_id, id),
 foreign key (organisation_id, added_by) references memberships(organisation_id, user_id)
);
create table model_budgets (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 month date not null check (extract(day from month) = 1),
 limit_tokens bigint not null check (limit_tokens between 0 and 9007199254740991),
 cost_limit_micros bigint check (cost_limit_micros between 0 and 9007199254740991),
 used_tokens bigint not null default 0 check (used_tokens between 0 and 9007199254740991),
 unique (organisation_id, month), unique (organisation_id, id)
);
create table model_usage (
 id uuid primary key default uuidv7(),
 organisation_id uuid not null references organisations(id) on delete cascade,
 run_id uuid, step_key text not null, tier text not null check (tier in ('small', 'large')),
 provider text not null check (provider in ('claude', 'codex')), model text not null,
 input_tokens bigint not null check (input_tokens >= 0), output_tokens bigint not null check (output_tokens >= 0),
 cost_micros bigint check (cost_micros between 0 and 9007199254740991),
 latency_ms integer not null check (latency_ms >= 0), created_at timestamptz not null default now(),
 unique (organisation_id, id)
);
-- workflow_runs does not exist yet; add a composite run FK with the runner's migration.
create index model_usage_month on model_usage (organisation_id, created_at);

alter table inference_runtimes enable row level security;
alter table inference_runtimes force row level security;
create policy inference_runtime_read on inference_runtimes for select to app
 using (organisation_id = current_organisation_id());
create policy inference_runtime_insert on inference_runtimes for insert to app
 with check (organisation_id = current_organisation_id() and exists (select 1 from memberships m
  where m.organisation_id = current_organisation_id() and m.user_id = current_user_id() and m.role = 'owner' and m.status = 'active'));
create policy inference_runtime_update on inference_runtimes for update to app
 using (organisation_id = current_organisation_id() and exists (select 1 from memberships m
  where m.organisation_id = current_organisation_id() and m.user_id = current_user_id() and m.role = 'owner' and m.status = 'active'))
 with check (organisation_id = current_organisation_id());

alter table model_budgets enable row level security;
alter table model_budgets force row level security;
create policy model_budget_tenant on model_budgets for all to app
 using (organisation_id = current_organisation_id() and exists (select 1 from memberships m
  where m.organisation_id = current_organisation_id() and m.user_id = current_user_id() and m.status = 'active'))
 with check (organisation_id = current_organisation_id() and exists (select 1 from memberships m
  where m.organisation_id = current_organisation_id() and m.user_id = current_user_id() and m.status = 'active'));
-- Members may settle workflow usage but cannot change an allowance, including on lazy creation.
create function inference_budget_limit_guard() returns trigger language plpgsql as $$
begin
 if TG_OP = 'INSERT' then
  if NEW.cost_limit_micros is not null then
   raise exception 'cost allowances are not enabled' using errcode = '42501';
  end if;
  if NEW.limit_tokens <> coalesce((select (settings->>'inferenceLimitTokens')::bigint from organisations where id = NEW.organisation_id), 0) then
   raise exception 'allowance must match organisation settings' using errcode = '42501';
  end if;
 elsif (NEW.limit_tokens <> OLD.limit_tokens or NEW.cost_limit_micros is distinct from OLD.cost_limit_micros) and not exists (select 1 from memberships
  where organisation_id = current_organisation_id() and user_id = current_user_id() and status = 'active' and role in ('owner', 'admin')) then
  raise exception 'only owner or admin can change allowance' using errcode = '42501';
 end if;
 return NEW;
end $$;
create trigger model_budget_limit before insert or update on model_budgets for each row execute function inference_budget_limit_guard();

alter table model_usage enable row level security;
alter table model_usage force row level security;
create policy model_usage_tenant on model_usage for all to app
 using (organisation_id = current_organisation_id())
 with check (organisation_id = current_organisation_id() and exists (select 1 from memberships m
  where m.organisation_id = current_organisation_id() and m.user_id = current_user_id() and m.status = 'active'));
grant select, insert, update on inference_runtimes, model_budgets to app;
grant select, insert on model_usage to app;
-- The monthly default is also a role-checked write, even through the organisation table.
create function inference_default_limit_guard() returns trigger language plpgsql as $$
begin
 if NEW.settings->'inferenceLimitTokens' is distinct from OLD.settings->'inferenceLimitTokens' then
  if not exists (select 1 from memberships where organisation_id = current_organisation_id()
   and user_id = current_user_id() and status = 'active' and role in ('owner', 'admin')) then
   raise exception 'only owner or admin can change allowance' using errcode = '42501';
  end if;
  if jsonb_typeof(NEW.settings->'inferenceLimitTokens') is distinct from 'number'
   or (NEW.settings->>'inferenceLimitTokens')::numeric not between 0 and 9007199254740991
   or trunc((NEW.settings->>'inferenceLimitTokens')::numeric) <> (NEW.settings->>'inferenceLimitTokens')::numeric then
   raise exception 'invalid monthly allowance' using errcode = '23514';
  end if;
 end if;
 return NEW;
end $$;
create trigger inference_default_limit before update on organisations for each row execute function inference_default_limit_guard();
