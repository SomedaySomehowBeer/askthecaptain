-- Sub-tasks and the project brief (D7, plan §2). A sub-task is a task whose parent is another task in the same
-- project, one level deep, with no series and no sub-tasks of its own: a task's checklist, never a project.
alter table tasks add column parent_id uuid;
alter table tasks add constraint tasks_parent_fk foreign key (organisation_id, parent_id) references tasks(organisation_id, id) on delete cascade;
alter table tasks add constraint tasks_step_has_no_series check (parent_id is null or series_id is null);
create index tasks_parent on tasks (organisation_id, parent_id) where parent_id is not null;
-- Depth and project are checked here because a foreign key cannot say "and that row has no parent".
create function tasks_check_parent() returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare parent record;
begin
	if new.parent_id is not null then
		if new.parent_id = new.id then raise exception 'a task cannot be its own parent' using errcode = 'check_violation'; end if;
		select project_id, parent_id into parent from public.tasks where organisation_id = new.organisation_id and id = new.parent_id;
		if parent is null then raise exception 'the parent task does not exist' using errcode = 'foreign_key_violation'; end if;
		if parent.parent_id is not null then raise exception 'a step cannot have steps of its own' using errcode = 'check_violation'; end if;
		if parent.project_id <> new.project_id then raise exception 'a step belongs to its task''s project' using errcode = 'check_violation'; end if;
		if exists (select 1 from public.tasks where organisation_id = new.organisation_id and parent_id = new.id) then raise exception 'a task with steps cannot become a step' using errcode = 'check_violation'; end if;
	end if;
	return new;
end $$;
revoke all on function tasks_check_parent() from public;
create trigger tasks_check_parent before insert or update of parent_id, project_id on tasks for each row execute function tasks_check_parent();
-- The brief: what this is, where it stands, who is involved, open questions; each line may cite a thread or note.
-- Written by discovery, editable by a person; the whole of an idea-stage project that has no tasks yet.
alter table projects add column stage text not null default 'underway' check (stage in ('idea', 'underway'));
alter table projects add column brief jsonb not null default '{"what": [], "standing": [], "people": [], "questions": []}'::jsonb;
alter table projects add column brief_updated_at timestamptz;
alter table projects add column brief_updated_by uuid references users(id) on delete set null;
alter table projects add column brief_run_id uuid;
