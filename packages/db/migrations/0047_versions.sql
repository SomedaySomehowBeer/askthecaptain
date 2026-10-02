-- R3 versions (docs/plans/versions-and-undo-2026-10.md, PR V-B; D29): the change journal. Three tables (change_sets,
-- record_changes, record_versions), the database triggers that write them, a baseline version of every existing
-- record, change lines in record threads, and the two state stores that leave audit_events (stocktake idempotency
-- moves to change-set retry ids in code; Xero sync state moves to xero_sync_state here).
--
-- How a write is journalled (contract §2):
--   1. The caller opens one change set for the organisation in its transaction with change_set_open(...), which also
--      sets app.change_set_id. A retried id with the same actor and request fingerprint is 'matched' (the caller writes
--      nothing and answers from what the first write did); anything else holding the id is 'unavailable'.
--   2. Every insert, update or delete of a journalled table runs journal_guard() at once (after the row, so row
--      security, checks and foreign keys answer first): no change set of this transaction for this organisation, no
--      write.
--   3. journal_capture(), a deferred constraint trigger on the same tables, runs at commit for each row event, when the
--      transaction's writes are final. It compares the fixed field list (journal_fields()) of the old and new row and
--      writes one record_changes row per changed field or item, then, for the first event of a record that changed
--      anything, the record's one version (the full row with its steps, evidence and tags, as it is at commit) and the
--      record's one change line in its thread. Deferring is what makes "one version per record per change set" and
--      the final result revision exact without per-field snapshots: a step insert followed by its parent's revision
--      touch, or a task update followed by its steps' cascade, all land before the version is taken.
--
-- Security: the journal functions are security definer (they write tables the runtime may only read, and read change
-- sets whose select policy hides them until they have visible changes); each sets a fixed search_path and the UTC time
-- zone (so timestamps in before/after are written one way) and is revoked from public. Only change_set_open and
-- record_visible are callable. The runtime holds select on the three tables and insert on change_sets alone: nothing in
-- them is updated or deleted by the runtime.
--
-- No CASCADE anywhere: an unknown dependency fails the migration instead of silently taking something with it.

do $$ begin
	if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
		raise exception 'migration 0047 must run as a role that bypasses row security (the migration owner)';
	end if;
end $$;

-- runtime-role precondition: begin
do $$ declare runtime constant name := 'captain_runtime'; problems text[];
begin
	select array_remove(array[
		case when r.rolsuper then 'superuser' end,
		case when r.rolbypassrls then 'bypassrls' end,
		case when r.rolcreaterole then 'createrole' end,
		case when r.rolcreatedb then 'createdb' end,
		case when r.rolreplication then 'replication' end,
		case when exists (select 1 from pg_auth_members m where m.member = r.oid) then 'member of another role' end,
		case when exists (select 1 from pg_shdepend d where d.refclassid = 'pg_authid'::regclass and d.refobjid = r.oid and d.deptype = 'o')
			then 'owns objects' end], null)
	into problems from pg_roles r where r.rolname = runtime;
	if problems is null then raise exception 'migration 0047 requires the runtime role % (created by 0041_runtime_role)', runtime; end if;
	if cardinality(problems) > 0 then
		raise exception 'runtime role % is not safe for row security: %', runtime, array_to_string(problems, ', ');
	end if;
end $$;
-- runtime-role precondition: end

-- Hold what this changes. Nothing should hold these locks with HTTP stopped; fail within 30 s if something does.
set local lock_timeout = '30s';
lock table tasks, task_series, evidence, equipment, equipment_reservations, stock_items, tags, thread_tags, task_series_tags,
	threads, thread_messages, thread_pins, connections in share row exclusive mode;

-- A stock item gets the revision every other record has, so its versions and a later reversal's basis can name one.
-- Existing items start at 1; every update moves it (0039's function), whoever writes it.
alter table stock_items add column revision integer not null default 1;
alter table stock_items add constraint stock_items_revision_check check (revision > 0);
create trigger stock_items_revision before update on stock_items for each row execute function work_revision_bump();

-- Tables -------------------------------------------------------------------------------------------------------

-- One per action. `id` is the client's retry id for a person's write, a deterministic id for a workflow step, and a
-- server uuidv7 otherwise. One change set per organisation per transaction (created_xact), so the commit-time journal
-- knows which one a row event belongs to without trusting a setting that could have moved.
create table change_sets (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	actor_id uuid, -- the membership that acted (a workflow's enabling person); null for the system
	actor_kind text not null,
	cause_kind text not null,
	cause_id text, -- the request id, the workflow run id, the reversed change set id, or the routine's name
	request_id text,
	fingerprint bytea, -- sha256 of the normalised request: a retry with the same id must match it
	created_xact xid8 not null default pg_current_xact_id(),
	created_at timestamptz not null default now(),
	constraint change_sets_organisation_id_id_key unique (organisation_id, id),
	foreign key (organisation_id, actor_id) references memberships(organisation_id, user_id) on delete set null (actor_id),
	constraint change_sets_actor_kind_check check (actor_kind in ('person', 'workflow', 'system')),
	constraint change_sets_cause_kind_check check (cause_kind in ('request', 'workflow_run', 'routine', 'reversal', 'baseline')),
	constraint change_sets_system_check check (actor_kind <> 'system' or actor_id is null),
	constraint change_sets_cause_check check (cause_id is null or char_length(cause_id) between 1 and 200),
	constraint change_sets_request_check check (request_id is null or char_length(request_id) between 1 and 200),
	constraint change_sets_fingerprint_check check (fingerprint is null or octet_length(fingerprint) = 32)
);
create unique index change_sets_one_per_transaction on change_sets (organisation_id, created_xact);
create index change_sets_by_time on change_sets (organisation_id, created_at desc, id desc);

-- One per changed field or item, immutable. `before`/`after` are typed JSON: the field's value (JSON null for SQL
-- null) for an update; the item's or record's full row for a create, remove, attach or detach.
create table record_changes (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	change_set_id uuid not null,
	record_kind text not null,
	record_id uuid not null,
	operation text not null,
	field text,
	item_kind text,
	item_id uuid,
	before jsonb,
	after jsonb,
	base_revision integer, -- the record's revision in its previous version; null when this change set created it
	result_revision integer not null, -- the record's revision when this change set committed
	reverses_change_id uuid, -- set on a reversal's changes (V-C)
	created_at timestamptz not null default now(),
	constraint record_changes_organisation_id_id_key unique (organisation_id, id),
	foreign key (organisation_id, change_set_id) references change_sets(organisation_id, id) on delete cascade,
	foreign key (organisation_id, reverses_change_id) references record_changes(organisation_id, id) on delete cascade,
	constraint record_changes_record_kind_check check (record_kind in ('task', 'reservation', 'stock_item', 'series', 'equipment', 'tag', 'thread')),
	constraint record_changes_operation_check check (operation in ('create', 'update', 'remove', 'attach', 'detach')),
	constraint record_changes_item_check check ((item_kind is null) = (item_id is null) and (item_kind is null or item_kind in ('step', 'evidence', 'tag'))),
	constraint record_changes_field_check check ((operation = 'update') = (field is not null) and (field is null or field ~ '^[a-z_]{1,60}$')),
	constraint record_changes_shape_check check (
		(operation = 'update' and before is not null and after is not null)
		or (operation in ('create', 'attach') and before is null and jsonb_typeof(after) = 'object')
		or (operation in ('remove', 'detach') and jsonb_typeof(before) = 'object' and after is null)),
	constraint record_changes_tag_check check ((operation in ('attach', 'detach')) = (item_kind is not distinct from 'tag')),
	constraint record_changes_revision_check check ((base_revision is null or base_revision > 0) and result_revision > 0)
);
create index record_changes_by_record on record_changes (organisation_id, record_kind, record_id, id);
create index record_changes_by_set on record_changes (change_set_id, id);
create index record_changes_by_item on record_changes (organisation_id, record_kind, record_id, item_kind, item_id, id) where item_id is not null;

-- The full record after a change set, with its steps, evidence and tags, for inspection; never restored wholesale.
create table record_versions (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	change_set_id uuid not null,
	record_kind text not null,
	record_id uuid not null,
	revision integer not null,
	snapshot jsonb not null,
	created_at timestamptz not null default now(),
	constraint record_versions_organisation_id_id_key unique (organisation_id, id),
	constraint record_versions_one_per_set unique (change_set_id, record_kind, record_id),
	foreign key (organisation_id, change_set_id) references change_sets(organisation_id, id) on delete cascade,
	constraint record_versions_record_kind_check check (record_kind in ('task', 'reservation', 'stock_item', 'series', 'equipment', 'tag', 'thread')),
	constraint record_versions_revision_check check (revision > 0),
	constraint record_versions_snapshot_check check (jsonb_typeof(snapshot) = 'object')
);
create index record_versions_by_record on record_versions (organisation_id, record_kind, record_id, id);

-- Xero's sync state, which the connection and money reads took from audit_events until now (contract §2).
create table xero_sync_state (
	organisation_id uuid not null references organisations(id) on delete cascade,
	connection_id uuid primary key,
	state text not null,
	error text,
	state_at timestamptz not null default now(),
	last_synced_at timestamptz, -- the latest completed sync since the connection was last made; null until then
	foreign key (organisation_id, connection_id) references connections(organisation_id, id) on delete cascade,
	constraint xero_sync_state_state_check check (state in ('started', 'synced', 'failed')),
	constraint xero_sync_state_error_check check (error is null or char_length(error) <= 1000)
);

-- Change lines: a thread message of kind 'change' names its change set and has no body.
alter table thread_messages add column change_set_id uuid;
alter table thread_messages add constraint thread_messages_change_set_fkey
	foreign key (organisation_id, change_set_id) references change_sets(organisation_id, id) on delete cascade;
alter table thread_messages drop constraint thread_messages_tombstone_check;
alter table thread_messages add constraint thread_messages_tombstone_check check (
	(kind = 'change' and change_set_id is not null and body is null and sent_body_sha256 is null and deleted_at is null and deleted_by is null and edited_at is null)
	or (kind <> 'change' and change_set_id is null and (
		(deleted_at is null and body is not null and sent_body_sha256 is not null and deleted_by is null)
		or (deleted_at is not null and body is null and sent_body_sha256 is null))));
-- One change line per thread per change set.
create unique index thread_messages_change_set on thread_messages (thread_id, change_set_id) where change_set_id is not null;

-- The fixed field lists (contract §2) ------------------------------------------------------------------------------

-- The fields an update compares, per journalled table. Everything else is bookkeeping (updated_at, revision,
-- occupied_* which follow from the times, counters) or fixed when the row is made (ids, parent, source, creator).
-- packages/db/src/versions.ts mirrors this list; a test keeps the two equal. thread_tags and task_series_tags have
-- no fields: a tag is attached or detached, never changed.
create function journal_fields() returns jsonb language sql immutable set search_path = pg_catalog, public, pg_temp as $$
	select '{
		"tasks": ["title", "body", "status", "owner_id", "due", "evidence_required", "completed_by", "completed_at", "series_id", "period_start", "period_end"],
		"task_series": ["title", "body", "owner_id", "evidence_required", "recurrence", "every_months", "anchor", "due_offset_days", "paused_at"],
		"evidence": ["kind", "reference", "label"],
		"equipment": ["name", "archived_at"],
		"equipment_reservations": ["equipment_id", "title", "kind", "status", "starts_at", "ends_at", "setup_minutes", "cleanup_minutes", "task_id", "owner_id"],
		"stock_items": ["name", "location", "unit_label", "current_count", "counted_at", "counted_by", "reorder_point", "preferred_supplier_id", "notes", "archived_at"],
		"tags": ["name", "owner_id", "starts_on", "ends_on", "archived_at"],
		"thread_tags": [],
		"task_series_tags": []
	}'::jsonb
$$;

-- A journalled row as typed JSON: the table's own columns without the tenant, counts as decimal strings (as the API
-- returns them). Timestamps are rendered by the caller's UTC time zone setting.
create function journal_row(p_table text, p_row jsonb) returns jsonb language sql immutable set search_path = pg_catalog, public, pg_temp as $$
	select case when p_table = 'stock_items'
		then (p_row - 'organisation_id') || jsonb_build_object('current_count', p_row ->> 'current_count', 'reorder_point', p_row ->> 'reorder_point')
		else p_row - 'organisation_id' end
$$;

-- An update whose only changes clear attribution columns of a member who no longer exists (an account or membership
-- deletion's `on delete set null`, as 0046's Rule A) is the database keeping its references, not a business change: it
-- needs no change set and is not journalled. The revision and updated_at may move with it (0039's trigger).
create function journal_attribution_erasure(p_table text, p_organisation uuid, p_old jsonb, p_new jsonb) returns boolean
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
	with attribution(columns) as (select case p_table
			when 'tasks' then array['owner_id', 'completed_by', 'created_by']
			when 'task_series' then array['owner_id', 'created_by']
			when 'evidence' then array['attached_by']
			when 'tags' then array['owner_id', 'created_by']
			when 'thread_tags' then array['attached_by']
			else array[]::text[] end),
		changed(name) as (select k from jsonb_object_keys(p_old) k
			where k not in ('revision', 'updated_at') and (p_old -> k) is distinct from (p_new -> k))
	select exists (select 1 from changed) and not exists (select 1 from changed, attribution
		where not (changed.name = any(attribution.columns)) or (p_new ->> changed.name) is not null
			or exists (select 1 from memberships m where m.organisation_id = p_organisation and m.user_id = (p_old ->> changed.name)::uuid))
$$;

-- Access (contract §2) ---------------------------------------------------------------------------------------------

-- The one predicate every journal policy uses. A thread's own history (its tags) follows thread_visible, so a private
-- thread's history is its participants'. Every work record's policy is member-wide today, so its history is visible
-- to an active member of the current organisation; with no person (a system routine) nothing is. A migration that
-- narrows a record's policy must narrow this function in the same file.
create function record_visible(p_kind text, p_id uuid) returns boolean
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
	select case when p_kind = 'thread' then thread_visible(p_id)
		else exists (select 1 from memberships m where m.organisation_id = current_organisation_id()
			and m.user_id = current_user_id() and m.status = 'active') end
$$;

-- The record's revision now, or null when it no longer exists.
create function journal_revision(p_kind text, p_id uuid) returns integer
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
	select case p_kind
		when 'task' then (select revision from tasks where id = p_id)
		when 'reservation' then (select revision from equipment_reservations where id = p_id)
		when 'stock_item' then (select revision from stock_items where id = p_id)
		when 'series' then (select revision from task_series where id = p_id)
		when 'equipment' then (select revision from equipment where id = p_id)
		when 'tag' then (select revision from tags where id = p_id)
		when 'thread' then (select revision from threads where id = p_id) end
$$;

-- The record as it is now, with its steps (each with its evidence), evidence and tag ids; null when it is gone.
-- A topic or private thread's record is its title, kind and tags: the messages are not part of it.
create function journal_snapshot(p_kind text, p_id uuid) returns jsonb
	language sql stable security definer set search_path = pg_catalog, public, pg_temp set timezone = 'UTC' as $$
	select case p_kind
	when 'task' then (select jsonb_build_object('row', journal_row('tasks', to_jsonb(t)),
		'steps', coalesce((select jsonb_agg(journal_row('tasks', to_jsonb(s)) || jsonb_build_object('evidence',
			coalesce((select jsonb_agg(journal_row('evidence', to_jsonb(se)) order by se.attached_at, se.id) from evidence se where se.task_id = s.id), '[]'::jsonb))
			order by s.created_at, s.id) from tasks s where s.parent_id = t.id), '[]'::jsonb),
		'evidence', coalesce((select jsonb_agg(journal_row('evidence', to_jsonb(e)) order by e.attached_at, e.id) from evidence e where e.task_id = t.id), '[]'::jsonb),
		'tags', coalesce((select jsonb_agg(tt.tag_id order by tt.tag_id) from threads th join thread_tags tt on tt.thread_id = th.id where th.task_id = t.id), '[]'::jsonb))
		from tasks t where t.id = p_id)
	when 'reservation' then (select jsonb_build_object('row', journal_row('equipment_reservations', to_jsonb(r)),
		'tags', coalesce((select jsonb_agg(tt.tag_id order by tt.tag_id) from threads th join thread_tags tt on tt.thread_id = th.id where th.reservation_id = r.id), '[]'::jsonb))
		from equipment_reservations r where r.id = p_id)
	when 'stock_item' then (select jsonb_build_object('row', journal_row('stock_items', to_jsonb(s)),
		'tags', coalesce((select jsonb_agg(tt.tag_id order by tt.tag_id) from threads th join thread_tags tt on tt.thread_id = th.id where th.stock_item_id = s.id), '[]'::jsonb))
		from stock_items s where s.id = p_id)
	when 'series' then (select jsonb_build_object('row', journal_row('task_series', to_jsonb(s)),
		'tags', coalesce((select jsonb_agg(st.tag_id order by st.tag_id) from task_series_tags st where st.series_id = s.id), '[]'::jsonb))
		from task_series s where s.id = p_id)
	when 'equipment' then (select jsonb_build_object('row', journal_row('equipment', to_jsonb(e))) from equipment e where e.id = p_id)
	when 'tag' then (select jsonb_build_object('row', journal_row('tags', to_jsonb(g))) from tags g where g.id = p_id)
	when 'thread' then (select jsonb_build_object('row', jsonb_build_object('id', th.id, 'kind', th.kind, 'title', th.title, 'created_by', th.created_by,
			'created_at', th.created_at, 'revision', th.revision),
		'tags', coalesce((select jsonb_agg(tt.tag_id order by tt.tag_id) from thread_tags tt where tt.thread_id = th.id), '[]'::jsonb))
		from threads th where th.id = p_id and th.kind <> 'record') end
$$;

-- Opening a change set (contract §5) --------------------------------------------------------------------------------

-- Opens this transaction's change set for the current organisation and sets app.change_set_id. The actor is the
-- transaction's person (app.user_id): a person or a workflow (written as its enabling person, D4) needs an active
-- membership; the system has no person. A null id gets a server uuidv7. An id already held is 'matched' only for the
-- same organisation, actor, actor kind and fingerprint, committed by an earlier transaction: the caller then writes
-- nothing and answers from that change set. Anything else is 'unavailable', without saying why. A concurrent first
-- use of the same id waits for the first to commit or roll back.
create function change_set_open(p_id uuid, p_actor_kind text, p_cause_kind text, p_cause_id text, p_request_id text, p_fingerprint bytea)
	returns table (change_set_id uuid, result text)
	language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
	org uuid := current_organisation_id();
	me uuid := current_user_id();
	wanted uuid := coalesce(p_id, uuidv7());
	inserted uuid;
	existing record;
begin
	if org is null then
		raise exception 'a change set needs an organisation' using errcode = 'insufficient_privilege';
	end if;
	if p_actor_kind is null or p_actor_kind not in ('person', 'workflow', 'system') then
		raise exception 'a change set''s actor is a person, a workflow or the system' using errcode = 'check_violation';
	end if;
	if p_cause_kind is null or p_cause_kind not in ('request', 'workflow_run', 'routine', 'reversal') then
		raise exception 'a change set is caused by a request, a workflow run, a routine or a reversal' using errcode = 'check_violation';
	end if;
	if p_actor_kind = 'system' then
		if me is not null then
			raise exception 'a system change set has no person' using errcode = 'check_violation';
		end if;
	else
		perform 1 from memberships where organisation_id = org and user_id = me and status = 'active' for share;
		if me is null or not found then
			raise exception 'a change set needs an active member to act' using errcode = 'insufficient_privilege';
		end if;
	end if;
	insert into change_sets (id, organisation_id, actor_id, actor_kind, cause_kind, cause_id, request_id, fingerprint)
		values (wanted, org, me, p_actor_kind, p_cause_kind, p_cause_id, p_request_id, p_fingerprint)
		on conflict (id) do nothing
		returning change_sets.id into inserted;
	if inserted is not null then
		perform set_config('app.change_set_id', inserted::text, true);
		return query select inserted, 'created'::text;
		return;
	end if;
	select c.organisation_id, c.actor_id, c.actor_kind, c.fingerprint, c.created_xact into existing from change_sets c where c.id = wanted;
	if found and existing.organisation_id = org and existing.actor_id is not distinct from me and existing.actor_kind = p_actor_kind
		and existing.fingerprint is not null and existing.fingerprint = p_fingerprint and existing.created_xact <> pg_current_xact_id() then
		return query select wanted, 'matched'::text;
		return;
	end if;
	return query select wanted, 'unavailable'::text;
end $$;

-- A direct insert (allowed by the policy below) gets this transaction's identity and the server's time.
create function change_sets_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
	new.created_xact := pg_current_xact_id();
	new.created_at := now();
	return new;
end $$;

-- The journal (contract §2) -----------------------------------------------------------------------------------------

-- Immediate: a journalled write needs this transaction's change set for its organisation, named by app.change_set_id.
-- A row removed because its organisation is being deleted is not journalled: the journal goes with the organisation.
create function journal_guard() returns trigger
	language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare org uuid; named uuid;
begin
	if tg_op = 'DELETE' then org := old.organisation_id; else org := new.organisation_id; end if;
	if not exists (select 1 from organisations o where o.id = org) then
		return null;
	end if;
	if tg_op = 'UPDATE' and journal_attribution_erasure(tg_table_name, org, to_jsonb(old), to_jsonb(new)) then
		return null;
	end if;
	named := nullif(current_setting('app.change_set_id', true), '')::uuid;
	if named is null then
		raise exception 'a business write to % needs a change set: open one first (versions contract §2)', tg_table_name;
	end if;
	if not exists (select 1 from change_sets c where c.id = named and c.organisation_id = org and c.created_xact = pg_current_xact_id()) then
		raise exception 'app.change_set_id must name the change set this transaction opened for this organisation';
	end if;
	return null;
end $$;

-- Deferred, at commit: the change rows for one row event, then the record's version and change line once per change
-- set. Steps and evidence are items of their top-level task; a thread tag is an item of its record thread's record, or
-- of the thread itself for a topic or private thread; a series tag is an item of its series. An item whose record is
-- gone by commit is skipped: that record's removal is journalled by its own event.
create function journal_capture() returns trigger
	language plpgsql security definer set search_path = pg_catalog, public, pg_temp set timezone = 'UTC' as $$
declare
	o jsonb; n jsonb; r jsonb; org uuid; cs record;
	r_kind text; r_id uuid; i_kind text; i_id uuid;
	parent uuid; th record; f text;
	base integer; result integer; wrote integer := 0; versioned uuid; line_thread uuid; counters record;
begin
	if tg_op <> 'INSERT' then o := journal_row(tg_table_name, to_jsonb(old)); end if;
	if tg_op <> 'DELETE' then n := journal_row(tg_table_name, to_jsonb(new)); end if;
	r := coalesce(n, o);
	if tg_op = 'DELETE' then org := old.organisation_id; else org := new.organisation_id; end if;
	if not exists (select 1 from organisations x where x.id = org) then
		return null;
	end if;
	if tg_op = 'UPDATE' and journal_attribution_erasure(tg_table_name, org, to_jsonb(old), to_jsonb(new)) then
		return null; -- a deleted member's attribution cleared by a foreign key: not a change
	end if;
	select c.id, c.actor_id into cs from change_sets c where c.organisation_id = org and c.created_xact = pg_current_xact_id();
	if not found then
		raise exception 'a business write to % committed without a change set', tg_table_name;
	end if;

	if tg_table_name = 'tasks' then
		if r ->> 'parent_id' is null then r_kind := 'task'; r_id := (r ->> 'id')::uuid;
		else r_kind := 'task'; r_id := (r ->> 'parent_id')::uuid; i_kind := 'step'; i_id := (r ->> 'id')::uuid; end if;
	elsif tg_table_name = 'evidence' then
		select t.parent_id into parent from tasks t where t.id = (r ->> 'task_id')::uuid;
		if not found then return null; end if;
		r_kind := 'task'; r_id := coalesce(parent, (r ->> 'task_id')::uuid); i_kind := 'evidence'; i_id := (r ->> 'id')::uuid;
	elsif tg_table_name = 'thread_tags' then
		select t.id, t.kind, t.task_id, t.reservation_id, t.stock_item_id into th from threads t where t.id = (r ->> 'thread_id')::uuid;
		if not found then return null; end if;
		if th.task_id is not null then r_kind := 'task'; r_id := th.task_id;
		elsif th.reservation_id is not null then r_kind := 'reservation'; r_id := th.reservation_id;
		elsif th.stock_item_id is not null then r_kind := 'stock_item'; r_id := th.stock_item_id;
		else r_kind := 'thread'; r_id := th.id; end if;
		i_kind := 'tag'; i_id := (r ->> 'tag_id')::uuid;
	elsif tg_table_name = 'task_series_tags' then
		r_kind := 'series'; r_id := (r ->> 'series_id')::uuid; i_kind := 'tag'; i_id := (r ->> 'tag_id')::uuid;
	else
		r_kind := case tg_table_name when 'task_series' then 'series' when 'equipment' then 'equipment' when 'equipment_reservations' then 'reservation'
			when 'stock_items' then 'stock_item' when 'tags' then 'tag' end;
		if r_kind is null then raise exception 'journal_capture does not know table %', tg_table_name; end if;
		r_id := (r ->> 'id')::uuid;
	end if;

	result := journal_revision(r_kind, r_id);
	if result is null then
		if i_kind is not null or tg_op <> 'DELETE' then
			return null; -- the record went later in this transaction; its own removal is journalled
		end if;
		result := (o ->> 'revision')::integer;
	end if;
	select v.revision into base from record_versions v
		where v.organisation_id = org and v.record_kind = r_kind and v.record_id = r_id and v.change_set_id <> cs.id
		order by v.id desc limit 1;

	if i_kind = 'tag' then
		if tg_op = 'INSERT' then
			insert into record_changes (organisation_id, change_set_id, record_kind, record_id, operation, item_kind, item_id, after, base_revision, result_revision)
				values (org, cs.id, r_kind, r_id, 'attach', i_kind, i_id, n, base, result);
			wrote := 1;
		elsif tg_op = 'DELETE' then
			insert into record_changes (organisation_id, change_set_id, record_kind, record_id, operation, item_kind, item_id, before, base_revision, result_revision)
				values (org, cs.id, r_kind, r_id, 'detach', i_kind, i_id, o, base, result);
			wrote := 1;
		end if; -- an update of a tag attachment only clears a deleted member's attribution: not a change
	elsif tg_op = 'INSERT' then
		insert into record_changes (organisation_id, change_set_id, record_kind, record_id, operation, item_kind, item_id, after, base_revision, result_revision)
			values (org, cs.id, r_kind, r_id, 'create', i_kind, i_id, n, base, result);
		wrote := 1;
	elsif tg_op = 'DELETE' then
		insert into record_changes (organisation_id, change_set_id, record_kind, record_id, operation, item_kind, item_id, before, base_revision, result_revision)
			values (org, cs.id, r_kind, r_id, 'remove', i_kind, i_id, o, base, result);
		wrote := 1;
	else
		for f in select jsonb_array_elements_text(journal_fields() -> tg_table_name) loop
			if (o -> f) is distinct from (n -> f) then
				insert into record_changes (organisation_id, change_set_id, record_kind, record_id, operation, field, item_kind, item_id, before, after, base_revision, result_revision)
					values (org, cs.id, r_kind, r_id, 'update', f, i_kind, i_id, coalesce(o -> f, 'null'::jsonb), coalesce(n -> f, 'null'::jsonb), base, result);
				wrote := wrote + 1;
			end if;
		end loop;
	end if;
	if wrote = 0 then
		return null; -- bookkeeping only (a revision touch, updated_at): no change, no version
	end if;

	-- The record's one version in this change set: as it is at commit, or as it was just before its removal.
	insert into record_versions (organisation_id, change_set_id, record_kind, record_id, revision, snapshot)
		values (org, cs.id, r_kind, r_id, result,
			case when i_kind is null and tg_op = 'DELETE' then jsonb_build_object('row', o, 'removed', true) else journal_snapshot(r_kind, r_id) end)
		on conflict (change_set_id, record_kind, record_id) do nothing
		returning id into versioned;
	if versioned is null then
		return null; -- an earlier event of this change set already versioned the record and wrote its change line
	end if;

	-- The record's change line, in its thread: one per thread per change set, with the change set's actor as author.
	line_thread := case r_kind
		when 'task' then (select t.id from threads t where t.task_id = r_id)
		when 'reservation' then (select t.id from threads t where t.reservation_id = r_id)
		when 'stock_item' then (select t.id from threads t where t.stock_item_id = r_id)
		when 'thread' then (select t.id from threads t where t.id = r_id) end;
	if line_thread is not null then
		update threads set last_seq = last_seq + 1, last_change = last_change + 1, last_message_at = greatest(last_message_at, now())
			where id = line_thread returning last_seq, last_change into counters;
		insert into thread_messages (id, organisation_id, thread_id, kind, seq, change_seq, author_id, change_set_id)
			values (uuidv7(), org, line_thread, 'change', counters.last_seq, counters.last_change, cs.actor_id, cs.id);
	end if;
	return null;
end $$;

-- Thread guards, replaced for change lines (contract §3) ------------------------------------------------------------

-- 0046's message guard with one more insert path: a change line, inserted only by journal_capture (running as its
-- owner) for this transaction's change set. People still insert only messages; approval cards stay refused (R5). A
-- change line is never edited or deleted; only a deleted member's attribution may be cleared from it (Rule A).
create or replace function thread_messages_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	me uuid := current_user_id();
	counters record;
begin
	if tg_op = 'INSERT' then
		select t.last_seq, t.last_change, t.last_message_at into counters from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id;
		if not found then
			return new; -- invisible or absent: row security refuses it
		end if;
		if new.kind = 'change' then
			if current_user is distinct from (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.journal_capture()'::regprocedure)
				or new.change_set_id is null
				or not exists (select 1 from change_sets c where c.id = new.change_set_id and c.organisation_id = new.organisation_id
					and c.created_xact = pg_current_xact_id()) then
				raise exception 'a change line is written only by the journal, for this transaction''s change set' using errcode = 'check_violation';
			end if;
			if new.seq <> counters.last_seq or new.change_seq <> counters.last_change then
				raise exception 'a message takes the thread''s newly advanced counters' using errcode = 'check_violation';
			end if;
			if new.body is not null or new.sent_body_sha256 is not null or new.deleted_at is not null or new.deleted_by is not null
				or new.edited_at is not null or new.revision <> 1 then
				raise exception 'a change line has no body and is never edited' using errcode = 'check_violation';
			end if;
			new.created_at := coalesce(counters.last_message_at, now());
			return new;
		end if;
		if new.kind <> 'message' then
			raise exception 'only a message can be sent' using errcode = 'check_violation';
		end if;
		if new.change_set_id is not null then
			raise exception 'only a change line names a change set' using errcode = 'check_violation';
		end if;
		if me is null or new.author_id is distinct from me or not thread_visible(new.thread_id) then
			raise exception 'only someone who can see the thread sends, as themselves' using errcode = 'check_violation';
		end if;
		if new.seq <> counters.last_seq or new.change_seq <> counters.last_change then
			raise exception 'a message takes the thread''s newly advanced counters' using errcode = 'check_violation';
		end if;
		if new.body is null or new.sent_body_sha256 is null or new.deleted_at is not null or new.deleted_by is not null
			or new.edited_at is not null or new.revision <> 1 then
			raise exception 'a message is sent live, unedited, at revision 1' using errcode = 'check_violation';
		end if;
		if exists (select 1 from thread_pins tp where tp.thread_id = new.thread_id and tp.change_seq = new.change_seq) then
			raise exception 'that change number is already held by a pin' using errcode = 'check_violation';
		end if;
		new.created_at := coalesce(counters.last_message_at, now());
		return new;
	end if;
	if (to_jsonb(new) - array['author_id', 'deleted_by']) = (to_jsonb(old) - array['author_id', 'deleted_by'])
		and (new.author_id is not distinct from old.author_id or (new.author_id is null
			and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.author_id)))
		and (new.deleted_by is not distinct from old.deleted_by or (new.deleted_by is null
			and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.deleted_by))) then
		return new;
	end if;
	if old.kind <> 'message' then
		raise exception 'a change line cannot be edited or deleted' using errcode = 'check_violation';
	end if;
	if old.deleted_at is not null then
		raise exception 'a deleted message cannot be changed' using errcode = 'check_violation';
	end if;
	if new.id <> old.id or new.organisation_id <> old.organisation_id or new.thread_id <> old.thread_id or new.kind <> old.kind
		or new.seq <> old.seq or new.created_at <> old.created_at or new.author_id is distinct from old.author_id
		or new.change_set_id is distinct from old.change_set_id then
		raise exception 'a message keeps its identity, place and author' using errcode = 'check_violation';
	end if;
	select t.last_change into counters from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id;
	if not found or not thread_visible(new.thread_id) then
		raise exception 'that message change is not allowed' using errcode = 'check_violation';
	end if;
	if exists (select 1 from thread_pins tp where tp.thread_id = new.thread_id and tp.change_seq = new.change_seq) then
		raise exception 'that change number is already held by a pin' using errcode = 'check_violation';
	end if;
	-- Tombstone: by the author, or by an owner or admin who can see the thread. The body can never be replaced.
	if new.deleted_at is not null
		and (me = old.author_id or exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = me
			and m.status = 'active' and m.role in ('owner', 'admin')))
		and new.body is null and new.sent_body_sha256 is null and new.deleted_by = me and new.revision = old.revision + 1
		and new.change_seq = counters.last_change and new.change_seq > old.change_seq
		and new.edited_at is not distinct from old.edited_at then
		new.deleted_at := now();
		return new;
	end if;
	-- Author edit: the author alone replaces the body; the original hash stays, so a send retry still matches.
	if new.deleted_at is null and me = old.author_id
		and new.body is not null and new.body <> old.body and new.sent_body_sha256 = old.sent_body_sha256 and new.deleted_by is null
		and new.revision = old.revision + 1 and new.change_seq = counters.last_change and new.change_seq > old.change_seq then
		new.edited_at := now();
		return new;
	end if;
	raise exception 'that message change is not allowed' using errcode = 'check_violation';
end $$;

-- 0046's pin guard, now refusing to pin anything but a message.
create or replace function thread_pins_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	me uuid := current_user_id();
	counters record;
	target record;
	moderator boolean;
begin
	select exists (select 1 from memberships m where m.organisation_id = current_organisation_id() and m.user_id = me
		and m.status = 'active' and m.role in ('owner', 'admin')) into moderator;
	if tg_op = 'INSERT' then
		select t.last_change into counters from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id;
		if not found then
			return new; -- invisible or absent: row security refuses it (no existence oracle)
		end if;
		if me is null or new.pinned_by is distinct from me or not thread_visible(new.thread_id) then
			raise exception 'only someone who can see the thread pins, as themselves' using errcode = 'check_violation';
		end if;
		if not moderator then
			raise exception 'only an owner or admin pins a message' using errcode = 'check_violation';
		end if;
		select m.thread_id, m.deleted_at, m.kind into target from thread_messages m where m.organisation_id = new.organisation_id and m.id = new.message_id;
		if not found or target.thread_id <> new.thread_id then
			raise exception 'a pin names a message in its own thread' using errcode = 'check_violation';
		end if;
		if target.kind <> 'message' then
			raise exception 'only a message can be pinned, not a change line' using errcode = 'check_violation';
		end if;
		if target.deleted_at is not null then
			raise exception 'a deleted message cannot be pinned' using errcode = 'check_violation';
		end if;
		if new.unpinned_at is not null or new.unpinned_by is not null then
			raise exception 'a pin starts live' using errcode = 'check_violation';
		end if;
		if new.change_seq <> counters.last_change then
			raise exception 'a pin takes the thread''s newly advanced change number' using errcode = 'check_violation';
		end if;
		if exists (select 1 from thread_messages m where m.thread_id = new.thread_id and m.change_seq = new.change_seq) then
			raise exception 'that change number is already held by a message' using errcode = 'check_violation';
		end if;
		new.pinned_at := now();
		return new;
	end if;
	if (to_jsonb(new) - array['pinned_by', 'unpinned_by']) = (to_jsonb(old) - array['pinned_by', 'unpinned_by'])
		and (new.pinned_by is not distinct from old.pinned_by or (new.pinned_by is null
			and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.pinned_by)))
		and (new.unpinned_by is not distinct from old.unpinned_by or (new.unpinned_by is null
			and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.unpinned_by))) then
		return new;
	end if;
	if old.unpinned_at is not null then
		raise exception 'an unpinned pin cannot be changed' using errcode = 'check_violation';
	end if;
	if new.id <> old.id or new.organisation_id <> old.organisation_id or new.thread_id <> old.thread_id
		or new.message_id <> old.message_id or new.pinned_by is distinct from old.pinned_by or new.pinned_at <> old.pinned_at then
		raise exception 'a pin keeps its identity, message and pinner' using errcode = 'check_violation';
	end if;
	select t.last_change into counters from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id;
	if not found then
		raise exception 'that pin change is not allowed' using errcode = 'check_violation';
	end if;
	if thread_visible(new.thread_id) and new.unpinned_at is not null and new.unpinned_by = me
		and (moderator or exists (select 1 from thread_messages m where m.id = old.message_id and m.deleted_at is not null))
		and new.change_seq = counters.last_change and new.change_seq > old.change_seq
		and not exists (select 1 from thread_messages m where m.thread_id = new.thread_id and m.change_seq = new.change_seq) then
		new.unpinned_at := now();
		return new;
	end if;
	raise exception 'that pin change is not allowed' using errcode = 'check_violation';
end $$;

-- Baseline (contract §2): one change set per organisation and one version per existing record at its current revision.
-- It invents no changes: history starts here. Set-based, so a few thousand records take a few statements.
insert into change_sets (organisation_id, actor_kind, cause_kind, cause_id) select id, 'system', 'baseline', '0047_versions' from organisations;
create temporary table baseline_records (organisation_id uuid not null, record_kind text not null, record_id uuid not null, revision integer not null) on commit drop;
insert into baseline_records
	select organisation_id, 'task', id, revision from tasks where parent_id is null
	union all select organisation_id, 'reservation', id, revision from equipment_reservations
	union all select organisation_id, 'stock_item', id, revision from stock_items
	union all select organisation_id, 'series', id, revision from task_series
	union all select organisation_id, 'equipment', id, revision from equipment
	union all select organisation_id, 'tag', id, revision from tags
	union all select organisation_id, 'thread', id, revision from threads where kind <> 'record';
insert into record_versions (organisation_id, change_set_id, record_kind, record_id, revision, snapshot)
	select b.organisation_id, c.id, b.record_kind, b.record_id, b.revision, journal_snapshot(b.record_kind, b.record_id)
	from baseline_records b join change_sets c on c.organisation_id = b.organisation_id and c.cause_kind = 'baseline'
	order by b.organisation_id, b.record_kind, b.record_id;
do $$ declare organisations_in bigint; sets bigint; records_in bigint; versions bigint; changes bigint; begin
	select count(*) into organisations_in from organisations;
	select count(*) into sets from change_sets where cause_kind = 'baseline';
	select count(*) into records_in from baseline_records;
	select count(*) into versions from record_versions;
	select count(*) into changes from record_changes;
	raise notice 'migration 0047: % baseline change sets, % record versions, % changes', sets, versions, changes;
	if sets <> organisations_in then raise exception 'migration 0047: % organisations but % baseline change sets', organisations_in, sets; end if;
	if versions <> records_in then raise exception 'migration 0047: % records but % baseline versions', records_in, versions; end if;
	if changes <> 0 then raise exception 'migration 0047: the baseline invents no changes, but % were written', changes; end if;
end $$;

-- Xero sync state from the audit rows the reads used: each Xero connection's latest sync event, and its latest completed
-- sync since it was last connected. A connection with no sync event has no row, which the reads take as "not synced".
insert into xero_sync_state (organisation_id, connection_id, state, error, state_at, last_synced_at)
	select c.organisation_id, c.id,
		case s.action when 'xero.synced' then 'synced' when 'xero.sync_failed' then 'failed' else 'started' end,
		case when s.action = 'xero.synced' then null else left(s.detail ->> 'error', 1000) end,
		s.created_at, l.created_at
	from connections c
	cross join lateral (select a.action, a.detail, a.created_at from audit_events a
		where a.organisation_id = c.organisation_id and a.subject_id = c.id::text and a.action in ('xero.sync_started', 'xero.synced', 'xero.sync_failed')
		order by a.created_at desc, a.id desc limit 1) s
	left join lateral (select a.created_at from audit_events a
		where a.organisation_id = c.organisation_id and a.subject_id = c.id::text and a.action = 'xero.synced'
			and a.created_at >= coalesce((select max(x.created_at) from audit_events x where x.organisation_id = c.organisation_id
				and x.subject_id = c.id::text and x.action = 'xero.connected'), '-infinity'::timestamptz)
		order by a.created_at desc, a.id desc limit 1) l on true
	where c.provider = 'xero';
do $$ declare moved bigint; begin
	select count(*) into moved from xero_sync_state;
	raise notice 'migration 0047: % Xero connections carry their sync state (the audit rows stay as history)', moved;
end $$;

-- Triggers ---------------------------------------------------------------------------------------------------------

create trigger change_sets_guard before insert on change_sets for each row execute function change_sets_guard();
do $$ declare t text; begin
	foreach t in array array['tasks', 'task_series', 'evidence', 'equipment', 'equipment_reservations', 'stock_items', 'tags', 'thread_tags', 'task_series_tags'] loop
		execute format('create trigger %I after insert or update or delete on public.%I for each row execute function journal_guard()', t || '_journal_guard', t);
		execute format('create constraint trigger %I after insert or update or delete on public.%I deferrable initially deferred for each row execute function journal_capture()', t || '_journal', t);
	end loop;
end $$;

-- Row security (all `to app, captain_runtime`) --------------------------------------------------------------------

alter table change_sets enable row level security;
alter table change_sets force row level security;
-- A change set is visible where one of its changes or versions is: a private thread's change sets stay its participants'.
create policy change_sets_select on change_sets for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and (
		exists (select 1 from record_changes c where c.organisation_id = change_sets.organisation_id and c.change_set_id = change_sets.id
			and record_visible(c.record_kind, c.record_id))
		or exists (select 1 from record_versions v where v.organisation_id = change_sets.organisation_id and v.change_set_id = change_sets.id
			and record_visible(v.record_kind, v.record_id))));
-- A direct insert names the transaction's own person (or none, for the system), never a baseline.
create policy change_sets_insert on change_sets for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and actor_id is not distinct from current_user_id() and cause_kind <> 'baseline'
		and (actor_kind = 'system') = (current_user_id() is null)
		and (current_user_id() is null or exists (select 1 from memberships m where m.organisation_id = change_sets.organisation_id
			and m.user_id = current_user_id() and m.status = 'active')));

alter table record_changes enable row level security;
alter table record_changes force row level security;
create policy record_changes_select on record_changes for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and record_visible(record_kind, record_id));

alter table record_versions enable row level security;
alter table record_versions force row level security;
create policy record_versions_select on record_versions for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and record_visible(record_kind, record_id));

-- Sync state is tenant data written by the sync routine, which has no person (as sync_cursors).
alter table xero_sync_state enable row level security;
alter table xero_sync_state force row level security;
create policy xero_sync_state_tenant on xero_sync_state for all to app, captain_runtime
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());

-- Grants: the journal is append-only and written by its definer functions; only change sets may be inserted directly.
grant select, insert on change_sets to app, captain_runtime;
grant select on record_changes, record_versions to app, captain_runtime;
grant select, insert, update on xero_sync_state to app, captain_runtime;

revoke all on function journal_fields(), journal_row(text, jsonb), journal_attribution_erasure(text, uuid, jsonb, jsonb), record_visible(text, uuid), journal_revision(text, uuid), journal_snapshot(text, uuid),
	change_set_open(uuid, text, text, text, text, bytea), change_sets_guard(), journal_guard(), journal_capture(),
	thread_messages_guard(), thread_pins_guard() from public;
grant execute on function record_visible(text, uuid), change_set_open(uuid, text, text, text, text, bytea), journal_fields() to app, captain_runtime;
