-- H2 B-A (docs/plans/bookings-and-equipment-2026-10.md §2; versions contract §6; D29): a topic thread becomes the record
-- thread of a new booking, as 0048 lets it become a task's. No table changes.
--
-- thread_make_booking() turns a visible topic thread into the record thread of a new confirmed booking on one piece of
-- equipment: the booking's title is the thread's, its kind `booking`, its creator the caller; the thread becomes kind
-- `record` with `reservation_id`, keeps its id, messages, tags and creator, and moves its revision once. The booking's
-- insert trigger makes no second thread for it, and the thread guard allows this transition only inside that function
-- (and the task one only inside thread_make_task, unchanged). Every 0046 guarantee stands: a booking still always has
-- exactly one thread, a private thread never becomes a record thread, and a record thread never changes kind or record.
-- The overlap constraint (0036) is the authority for the time, setup and cleanup it occupies, exactly as for a booking
-- made directly; archived equipment takes no booking. The booking's creation is journalled by 0047 under the caller's
-- change set, with its change line in the thread.
--
-- No CASCADE anywhere.

do $$ begin
	if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
		raise exception 'migration 0049 must run as a role that bypasses row security (the migration owner)';
	end if;
end $$;

set local lock_timeout = '30s';
lock table threads, equipment, equipment_reservations in share row exclusive mode;

-- The caller has opened this transaction's change set (the booking insert is journalled, so journal_guard refuses it
-- otherwise). The function takes, in the global lock order, the caller's membership, the owner's, the equipment, then
-- the thread. Times are checked by the table (0036): an end after the start, at most 366 days, within 1900–2200.
-- Returns the new booking's id.
create function thread_make_booking(p_thread uuid, p_equipment uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_setup_minutes integer,
	p_cleanup_minutes integer, p_owner uuid, p_expected_revision integer) returns uuid
	language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
	org uuid := current_organisation_id();
	me uuid := current_user_id();
	thread record;
	resource record;
	booking uuid := uuidv7();
	next_revision integer;
begin
	if org is null or me is null or p_thread is null or p_equipment is null then
		raise exception 'making a booking needs a person in an organisation' using errcode = 'insufficient_privilege';
	end if;
	perform 1 from memberships where organisation_id = org and user_id = me and status = 'active' for share;
	if not found then
		raise exception 'making a booking needs an active membership' using errcode = 'insufficient_privilege';
	end if;
	if p_owner is not null then
		perform 1 from memberships where organisation_id = org and user_id = p_owner and status = 'active' for share;
		if not found then
			raise exception 'a booking''s owner is an active member' using errcode = 'check_violation';
		end if;
	end if;
	select e.id, e.archived_at into resource from equipment e where e.id = p_equipment and e.organisation_id = org for update;
	if not found then
		raise exception 'that equipment is not available' using errcode = 'insufficient_privilege';
	end if;
	select t.id, t.kind, t.title, t.revision into thread from threads t where t.id = p_thread and t.organisation_id = org for update;
	-- Invisible and absent are the same answer.
	if not found or not thread_visible(p_thread) then
		raise exception 'that thread is not available' using errcode = 'insufficient_privilege';
	end if;
	if thread.kind <> 'topic' then
		raise exception 'only a topic thread becomes a booking' using errcode = 'check_violation';
	end if;
	if thread.revision is distinct from p_expected_revision then
		raise exception 'the thread changed since it was read' using errcode = 'serialization_failure';
	end if;
	if resource.archived_at is not null then
		raise exception 'archived equipment takes no booking' using errcode = 'check_violation';
	end if;
	perform set_config('app.topic_booking_id', booking::text, true);
	insert into equipment_reservations (id, organisation_id, equipment_id, title, kind, starts_at, ends_at, setup_minutes, cleanup_minutes,
		occupied_starts_at, occupied_ends_at, task_id, owner_id, created_by)
		values (booking, org, p_equipment, thread.title, 'booking', p_starts_at, p_ends_at, coalesce(p_setup_minutes, 0), coalesce(p_cleanup_minutes, 0),
			p_starts_at - coalesce(p_setup_minutes, 0) * interval '1 minute', p_ends_at + coalesce(p_cleanup_minutes, 0) * interval '1 minute', null, p_owner, me);
	update threads set kind = 'record', reservation_id = booking, title = null, create_fingerprint = null, revision = revision + 1
		where id = p_thread returning revision into next_revision;
	perform set_config('app.topic_booking_id', '', true);
	insert into chat_audit_events (organisation_id, thread_id, actor_id, action, subject_kind, subject_id, detail)
		values (org, p_thread, me, 'chat.thread_updated', 'thread', p_thread,
			jsonb_build_object('threadId', p_thread, 'revision', next_revision, 'reservationId', booking));
	return booking;
end $$;

-- 0048's record-thread trigger, unchanged except that the booking thread_make_booking inserts gets no thread of its own:
-- that function gives it the topic's. Only that function (running as its owner) can name such a booking.
create or replace function thread_for_record() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
	if tg_table_name = 'tasks' then
		if new.id::text = current_setting('app.topic_task_id', true)
			and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.thread_make_task(uuid, uuid, date, integer)'::regprocedure) then
			return null;
		end if;
		insert into threads (organisation_id, kind, task_id, created_by) values (new.organisation_id, 'record', new.id, current_user_id());
	elsif tg_table_name = 'equipment_reservations' then
		if new.id::text = current_setting('app.topic_booking_id', true)
			and current_user = (select pg_get_userbyid(p.proowner) from pg_proc p
				where p.oid = 'public.thread_make_booking(uuid, uuid, timestamptz, timestamptz, integer, integer, uuid, integer)'::regprocedure) then
			return null;
		end if;
		insert into threads (organisation_id, kind, reservation_id, created_by) values (new.organisation_id, 'record', new.id, current_user_id());
	elsif tg_table_name = 'stock_items' then
		insert into threads (organisation_id, kind, stock_item_id, created_by) values (new.organisation_id, 'record', new.id, current_user_id());
	else
		raise exception 'thread_for_record does not know table %', tg_table_name;
	end if;
	return null;
end $$;

-- 0048's thread guard with the topic-to-record path generalised: a topic becomes its new task's record thread only inside
-- thread_make_task, or its new booking's only inside thread_make_booking. Everything else is 0048's, unchanged.
create or replace function thread_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	me uuid := current_user_id();
	as_task boolean;
	as_booking boolean;
begin
	if tg_op = 'INSERT' then
		if new.created_by is distinct from me or new.last_seq <> 0 or new.last_change <> 0 or new.revision <> 1 or new.last_message_at is not null
			or (new.kind <> 'record' and me is null) then
			raise exception 'a thread starts empty, created by the person creating it' using errcode = 'check_violation';
		end if;
		new.created_at := now(); -- server time, never the caller's
		return new;
	end if;
	if (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
		and (new.created_by is not distinct from old.created_by or (new.created_by is null
			and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.created_by))) then
		return new;
	end if;
	if old.kind = 'topic' and new.kind = 'record' then
		-- Topic to task or booking: only inside its function, for the record it has just inserted, keeping everything but
		-- the title and fingerprint (a record thread has neither) and moving the revision once.
		as_task := current_user = (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.thread_make_task(uuid, uuid, date, integer)'::regprocedure)
			and new.task_id is not null and new.task_id::text = current_setting('app.topic_task_id', true)
			and new.reservation_id is null and new.stock_item_id is null;
		as_booking := current_user = (select pg_get_userbyid(p.proowner) from pg_proc p
				where p.oid = 'public.thread_make_booking(uuid, uuid, timestamptz, timestamptz, integer, integer, uuid, integer)'::regprocedure)
			and new.reservation_id is not null and new.reservation_id::text = current_setting('app.topic_booking_id', true)
			and new.task_id is null and new.stock_item_id is null;
		if not (coalesce(as_task, false) or coalesce(as_booking, false)) or new.title is not null or new.create_fingerprint is not null
			or new.id <> old.id or new.organisation_id <> old.organisation_id or new.created_at <> old.created_at or new.created_by is distinct from old.created_by
			or new.last_seq <> old.last_seq or new.last_change <> old.last_change or new.last_message_at is distinct from old.last_message_at
			or new.revision <> old.revision + 1 then
			raise exception 'a topic becomes a record''s thread only through thread_make_task or thread_make_booking' using errcode = 'check_violation';
		end if;
		return new;
	end if;
	if new.id <> old.id or new.organisation_id <> old.organisation_id or new.kind <> old.kind
		or new.task_id is distinct from old.task_id or new.reservation_id is distinct from old.reservation_id or new.stock_item_id is distinct from old.stock_item_id
		or new.create_fingerprint is distinct from old.create_fingerprint or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
		raise exception 'a thread keeps its identity, record, fingerprint and creator' using errcode = 'check_violation';
	end if;
	if new.last_seq not in (old.last_seq, old.last_seq + 1) or new.last_change not in (old.last_change, old.last_change + 1)
		or new.revision not in (old.revision, old.revision + 1) then
		raise exception 'thread counters move by at most one' using errcode = 'check_violation';
	end if;
	if new.revision <> old.revision then
		-- Title, participant and tag changes: revision only.
		if new.last_seq <> old.last_seq or new.last_change <> old.last_change or new.last_message_at is distinct from old.last_message_at then
			raise exception 'revision never moves with message counters' using errcode = 'check_violation';
		end if;
	else
		if new.title is distinct from old.title then
			raise exception 'a title change moves the revision' using errcode = 'check_violation';
		end if;
		if new.last_seq <> old.last_seq then
			if new.last_change <> old.last_change + 1 then
				raise exception 'a send moves last_seq and last_change together' using errcode = 'check_violation';
			end if;
			new.last_message_at := greatest(old.last_message_at, now());
		elsif new.last_message_at is distinct from old.last_message_at then
			raise exception 'last_message_at moves only with a send' using errcode = 'check_violation';
		end if;
	end if;
	return new;
end $$;

revoke all on function thread_make_booking(uuid, uuid, timestamptz, timestamptz, integer, integer, uuid, integer) from public;
grant execute on function thread_make_booking(uuid, uuid, timestamptz, timestamptz, integer, integer, uuid, integer) to app, captain_runtime;
