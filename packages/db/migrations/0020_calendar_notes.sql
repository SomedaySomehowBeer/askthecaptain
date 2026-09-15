-- Job 3: preparation stays local; sync still owns the provider event fields.
alter table calendar_events
 add column preparation_note text check (char_length(preparation_note) between 1 and 2000),
 add column prepared_by_run uuid,
 add column prepared_at timestamptz,
 add constraint calendar_note_time check ((preparation_note is null) = (prepared_at is null)),
 add constraint calendar_note_run foreign key (organisation_id, prepared_by_run)
  references workflow_runs(organisation_id, id) on delete set null (prepared_by_run);
-- Housekeeping has no person context. A person's/workflow's update requires active membership.
create policy calendar_events_active_writer on calendar_events as restrictive for update to app
 using (current_user_id() is null or exists (select 1 from memberships m where m.organisation_id = calendar_events.organisation_id and m.user_id = current_user_id() and m.status = 'active'))
 with check (current_user_id() is null or exists (select 1 from memberships m where m.organisation_id = calendar_events.organisation_id and m.user_id = current_user_id() and m.status = 'active'));
-- Any provider revision invalidates the saved preparation. Unchanged syncs preserve it.
create function clear_changed_event_note() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new) - array['preparation_note', 'prepared_by_run', 'prepared_at'])
  is distinct from (to_jsonb(old) - array['preparation_note', 'prepared_by_run', 'prepared_at']) then
  new.preparation_note := null; new.prepared_by_run := null; new.prepared_at := null;
 end if;
 return new;
end
$$;
create trigger calendar_note_source_changed before update on calendar_events
 for each row execute function clear_changed_event_note();
