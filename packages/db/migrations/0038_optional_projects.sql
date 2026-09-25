-- #133 step 4 (D7): a task or a series may belong to no project, and the generated Obligations
-- container is removed once nothing refers to it. The composite (organisation_id, project_id) foreign
-- keys stay: a null project_id is not checked, and a non-null one must still be this tenant's project.
-- Stop the old API before applying this: an old worker would recreate or write into the container.

-- Forced RLS applies to table owners and the policies are `to app`: a role that cannot bypass RLS would
-- see no rows, so the checks and removal below would silently pass. Fail instead.
do $$ begin
	if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
		raise exception 'migration 0038 must run as a role that bypasses row security (the migration owner)';
	end if;
end $$;

alter table tasks alter column project_id drop not null;
alter table task_series alter column project_id drop not null;

-- A step (checklist item) belongs to exactly its task's project, including none. `<>` let a null on
-- either side through; `is distinct from` compares nulls too. Otherwise unchanged from 0032.
create or replace function tasks_check_parent() returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare parent record;
begin
	if new.parent_id is not null then
		if new.parent_id = new.id then raise exception 'a task cannot be its own parent' using errcode = 'check_violation'; end if;
		select project_id, parent_id into parent from public.tasks where organisation_id = new.organisation_id and id = new.parent_id;
		if not found then raise exception 'the parent task does not exist' using errcode = 'foreign_key_violation'; end if;
		if parent.parent_id is not null then raise exception 'a step cannot have steps of its own' using errcode = 'check_violation'; end if;
		if parent.project_id is distinct from new.project_id then raise exception 'a step belongs to its task''s project' using errcode = 'check_violation'; end if;
		if exists (select 1 from public.tasks where organisation_id = new.organisation_id and parent_id = new.id) then raise exception 'a task with steps cannot become a step' using errcode = 'check_violation'; end if;
	end if;
	return new;
end $$;
revoke all on function tasks_check_parent() from public;

-- Equipment: a reservation may link a task that has no project. The service still requires a linked
-- task's project to equal the reservation's project, compared null-safely.
do $$
declare found_name text;
begin
	select conname into strict found_name from pg_constraint
	where conrelid = 'public.equipment_reservations'::regclass and contype = 'c'
		and pg_get_constraintdef(oid) = 'CHECK (((task_id IS NULL) OR (project_id IS NOT NULL)))';
	execute format('alter table public.equipment_reservations drop constraint %I', found_name);
end $$;

-- The generated Obligations container is removed, not archived, renamed or replaced. Old-version
-- content is cleared by the reviewed operational legacy reset before this migration; this migration
-- deletes no task, series or other work. If anything still refers to a system project, it stops and
-- names the table, so the reset can be finished deliberately. Every foreign key that references
-- projects is checked, including ones added after this file was written.
do $$
declare fk record; attached boolean;
begin
	-- The referencing column is whichever one maps to projects.id, whatever the key's column order.
	for fk in
		select c.conrelid::regclass as child, ca.attname as column_name
		from pg_constraint c
		cross join lateral unnest(c.conkey, c.confkey) as k(child_attnum, parent_attnum)
		join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = k.parent_attnum and pa.attname = 'id'
		join pg_attribute ca on ca.attrelid = c.conrelid and ca.attnum = k.child_attnum
		where c.contype = 'f' and c.confrelid = 'public.projects'::regclass
	loop
		execute format('select exists (select 1 from %s where %I in (select id from public.projects where system_kind is not null))',
			fk.child, fk.column_name) into attached;
		if attached then
			raise exception 'migration 0038: %.% still refers to a system Obligations project; finish the legacy reset first', fk.child, fk.column_name;
		end if;
	end loop;
end $$;

with removed as (delete from projects where system_kind is not null returning organisation_id, id, name)
insert into audit_events (organisation_id, actor_kind, action, subject_type, subject_id, detail)
select organisation_id, 'system', 'project.deleted', 'project', id,
	jsonb_build_object('systemKind', 'obligations', 'reason', 'generated_container_removed', 'migration', '0038') from removed;

-- No project is a system project any more; the flag and its one-per-kind index go with the behaviour.
alter table projects drop column system_kind;

-- The series routine's tenant discovery: a series with no project is active unless paused; a series
-- in a project is active while that project is not archived (as before).
create or replace function series_organisations() returns table (organisation_id uuid)
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
		select distinct s.organisation_id from public.task_series s
		left join public.projects p on p.organisation_id = s.organisation_id and p.id = s.project_id
		where s.paused_at is null and (s.project_id is null or p.archived_at is null)
	$$;
revoke all on function series_organisations() from public;
grant execute on function series_organisations() to app;
