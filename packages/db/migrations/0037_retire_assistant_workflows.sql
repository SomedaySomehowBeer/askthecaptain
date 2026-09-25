-- Captain/Pip split, #133: stop the old API machine before applying this migration.
-- Preserve immutable snapshots, outcomes, source records and audit history. Old task-reminder
-- and stocktake versions also contain correspondence branches; they require fresh enablement.
with retired as (
 update workflow_enablements set enabled = false, updated_at = now()
 where enabled and (definition_key in ('inbox-triage', 'discover-projects', 'calendar-prep', 'morning-brief')
  or (definition_key = 'chase-due' and definition_version <= 3)
  or (definition_key = 'stocktake' and definition_version <= 2))
 returning organisation_id, id, definition_key, definition_version
)
insert into audit_events (organisation_id, actor_kind, action, subject_type, subject_id, detail)
select organisation_id, 'system', 'workflow.retired', 'workflow_enablement', id,
 jsonb_build_object('definitionKey', definition_key, 'definitionVersion', definition_version, 'migration', '0037') from retired;
with retired as (
 update workflow_runs set state = 'cancelled', finished_at = now(), schedule_advanced = true,
 reason = 'This personal-assistant workflow version has been retired. Review the current workflows in Settings before enabling a replacement.'
 where state in ('queued', 'running', 'waiting', 'paused') and
 (definition_key in ('inbox-triage', 'discover-projects', 'calendar-prep', 'morning-brief')
  or (definition_key = 'chase-due' and definition_version <= 3)
  or (definition_key = 'stocktake' and definition_version <= 2))
 returning organisation_id, id, definition_key, definition_version
)
insert into audit_events (organisation_id, actor_kind, action, subject_type, subject_id, detail)
select organisation_id, 'system', 'workflow.cancelled', 'workflow_run', id,
 jsonb_build_object('reason', 'assistant_retirement', 'definitionKey', definition_key, 'definitionVersion', definition_version, 'migration', '0037') from retired;
-- Queue installation is optional in test/new databases. Remove all fully retired schedules and
-- pending jobs; for revised business workflows select old run versions. Completed job history
-- and unrelated/current-version schedules stay intact. No new version is enabled here.
do $$ begin
 if to_regclass('workflow_queue.schedule') is not null then
  execute $q$delete from workflow_queue.schedule where name in ('workflow_inbox-triage', 'workflow_discover-projects', 'workflow_calendar-prep', 'workflow_morning-brief')$q$;
  execute $q$delete from workflow_queue.schedule s using workflow_runs r
   where s.data ->> 'runId' = r.id::text 
   and (r.definition_key in ('inbox-triage', 'discover-projects', 'calendar-prep', 'morning-brief')
    or (r.definition_key = 'chase-due' and r.definition_version <= 3)
    or (r.definition_key = 'stocktake' and r.definition_version <= 2))$q$;
 end if;
 if to_regclass('workflow_queue.job') is not null then
  execute $q$delete from workflow_queue.job where state < 'completed' and name in ('workflow_inbox-triage', 'workflow_discover-projects', 'workflow_calendar-prep', 'workflow_morning-brief')$q$;
  execute $q$delete from workflow_queue.job j using workflow_runs r
   where j.data ->> 'runId' = r.id::text and j.state < 'completed' 
   and (r.definition_key in ('inbox-triage', 'discover-projects', 'calendar-prep', 'morning-brief')
    or (r.definition_key = 'chase-due' and r.definition_version <= 3)
    or (r.definition_key = 'stocktake' and r.definition_version <= 2))$q$;
 end if;
end $$;
