-- D26 (#140/#141): private saved Work views. A view is a name plus a versioned Work filter, evaluated for
-- its owner under their own permissions; it stores no results and grants nothing. Only the owner, while an
-- active member, can read or change it. Delete is a content-clearing tombstone so a retried create can
-- never resurrect it; physical removal happens only through the organisation or membership cascades.
create table saved_views (
	id uuid primary key, -- client-generated create identity (a matching retry returns the stored row)
	organisation_id uuid not null references organisations(id) on delete cascade,
	owner_id uuid not null,
	section text not null default 'work' check (section = 'work'),
	name text check (name is null or (name = btrim(name) and length(name) between 1 and 60)),
	-- Any positive version, so an older server can read a row written by a newer one and classify it.
	filter_version smallint check (filter_version is null or filter_version > 0),
	filter jsonb check (filter is null or (jsonb_typeof(filter) = 'object' and octet_length(filter::text) <= 4096)),
	deleted_at timestamptz,
	revision integer not null default 1 check (revision > 0),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (organisation_id, id),
	foreign key (organisation_id, owner_id) references memberships(organisation_id, user_id) on delete cascade,
	-- A live view has all of its content; a tombstone has none of it.
	constraint saved_views_content check ((deleted_at is null and name is not null and filter is not null and filter_version is not null)
		or (deleted_at is not null and name is null and filter is null and filter_version is null))
);
create unique index saved_views_name on saved_views (organisation_id, owner_id, lower(name)) where deleted_at is null;
create index saved_views_list on saved_views (organisation_id, owner_id, lower(name), id) where deleted_at is null;

-- Every update is a new revision (0039's function); a caller-supplied value is ignored.
create trigger saved_views_revision before update on saved_views for each row execute function work_revision_bump();

-- Identity is fixed and a tombstone is final. Row security's `with check` also keeps a row with its owner
-- and tenant; this refuses the change for every role, including the migration owner.
create function saved_views_fixed_identity() returns trigger language plpgsql as $$
begin
	if new.id is distinct from old.id or new.organisation_id is distinct from old.organisation_id
		or new.owner_id is distinct from old.owner_id or new.section is distinct from old.section
		or new.created_at is distinct from old.created_at then
		raise exception 'a saved view keeps its id, organisation, owner, section and creation time' using errcode = 'check_violation';
	end if;
	if old.deleted_at is not null then
		raise exception 'a deleted saved view cannot be changed' using errcode = 'check_violation';
	end if;
	return new;
end $$;
revoke all on function saved_views_fixed_identity() from public;
create trigger saved_views_identity before update on saved_views for each row execute function saved_views_fixed_identity();

-- Personal only: the owner, in their current tenant, while their membership is active. There is no policy
-- for anyone else's rows and no delete policy.
alter table saved_views enable row level security;
alter table saved_views force row level security;
create policy saved_views_owner_read on saved_views for select to app
	using (organisation_id = current_organisation_id() and owner_id = current_user_id() and exists (
		select 1 from memberships m where m.organisation_id = saved_views.organisation_id
			and m.user_id = current_user_id() and m.status = 'active'));
create policy saved_views_owner_insert on saved_views for insert to app
	with check (organisation_id = current_organisation_id() and owner_id = current_user_id() and exists (
		select 1 from memberships m where m.organisation_id = saved_views.organisation_id
			and m.user_id = current_user_id() and m.status = 'active'));
create policy saved_views_owner_update on saved_views for update to app
	using (organisation_id = current_organisation_id() and owner_id = current_user_id() and exists (
		select 1 from memberships m where m.organisation_id = saved_views.organisation_id
			and m.user_id = current_user_id() and m.status = 'active'))
	with check (organisation_id = current_organisation_id() and owner_id = current_user_id() and exists (
		select 1 from memberships m where m.organisation_id = saved_views.organisation_id
			and m.user_id = current_user_id() and m.status = 'active'));
-- No DELETE: neither SQL as `app` nor any API path can remove a tombstone. Referential cascades from the
-- organisation or membership row run as the table owner and still remove every row.
grant select, insert, update on saved_views to app;
