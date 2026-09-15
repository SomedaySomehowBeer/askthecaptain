-- D19 production runner. 0012 is reserved for the inbox/outbox slice.
alter table workflow_runs add column snapshot jsonb;
alter table workflow_runs add column enabled_by uuid references users(id) on delete set null;
alter table workflow_runs add column schedule_key text;
alter table workflow_runs add column schedule_advanced boolean not null default false;
alter table workflow_run_steps add column deadline timestamptz;
alter table workflow_run_steps add column wait_key text;
-- Full paths include every enclosing each index; item_index is also exposed in Activity.
create unique index workflow_step_path on workflow_run_steps (organisation_id, run_id, path);
create index workflow_wait_event on workflow_run_steps (organisation_id, wait_key) where state = 'waiting';
update workflow_runs set state = 'paused', reason = 'This run predates the production runner. Start a new run.'
 where state not in ('succeeded', 'failed', 'cancelled');
-- Queue payloads contain only a run id. This narrow platform lookup returns routing identifiers,
-- never definitions, parameters, outputs or mail. All journal access then uses forced tenant RLS.
create function workflow_run_context(wanted uuid) returns table(organisation_id uuid, user_id uuid)
 language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
 select r.organisation_id, r.enabled_by from public.workflow_runs r where r.id = wanted
$$;
revoke all on function workflow_run_context(uuid) from public;
grant execute on function workflow_run_context(uuid) to app;
-- Run inputs are immutable, even if an enablement or the catalogue is edited while it waits.
create function protect_workflow_snapshot() returns trigger language plpgsql as $$
begin
 if new.snapshot is distinct from old.snapshot or new.enablement_id <> old.enablement_id
  or new.definition_key <> old.definition_key or new.definition_version <> old.definition_version
  or new.definition_digest <> old.definition_digest or new.trigger is distinct from old.trigger then
  raise exception 'workflow run inputs are immutable' using errcode = '23514';
 end if;
 return new;
end
$$;
create trigger workflow_snapshot_immutable before update on workflow_runs for each row execute function protect_workflow_snapshot();
