-- R3 V-C (docs/plans/versions-and-undo-2026-10.md §4–§6; D29): what the reversal API and "make this a task" need from
-- the database. No table changes.
--
-- 1. Reversal links. A reversal is an ordinary write under a change set caused by `reversal`; the journal (0047) records
--    its changes at commit like any other. Before that, the API names, per field or item it will write, the change it
--    reverses, in the transaction setting `app.reverses` (a JSON object, key `kind:record:item_kind:item_id:field`).
--    record_changes_reverses() fills record_changes.reverses_change_id from it and checks the link: the same record,
--    item and field (or the same item for an attach, detach, create or remove), an earlier change in another change set
--    of this organisation. In a reversal change set every change must be linked, so a reversal cannot slip in an
--    unreversed write; outside one the setting is ignored.
-- 2. Topic to task (contract §0 decision 4, §6). thread_make_task() turns a visible topic thread into the record thread of
--    a new task: the task's title is the thread's, the thread becomes kind `record` with `task_id`, keeps its id,
--    messages, tags, participants (none: a topic has none) and creator, and moves its revision once. The task's insert
--    trigger makes no second thread for it, and the thread guard allows this one transition only inside that function.
--    Every other 0046 guarantee stands: a task still always has exactly one thread, a private thread never becomes a
--    record thread, and a record thread never changes kind or record. The task's creation is journalled by 0047 under
--    the caller's change set, with its change line in the thread.
--
-- No CASCADE anywhere.

do $$ begin
	if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
		raise exception 'migration 0048 must run as a role that bypasses row security (the migration owner)';
	end if;
end $$;

set local lock_timeout = '30s';
lock table threads, tasks, record_changes in share row exclusive mode;

-- 1. Reversal links ---------------------------------------------------------------------------------------------------

-- Before insert on record_changes, which only the journal's definer trigger inserts (the runtime holds no insert): runs
-- as the journal's owner. A malformed or unmatched link is an error, never a silent omission.
create function record_changes_reverses() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	cause text;
	links jsonb;
	wanted text;
	target record;
	key text := new.record_kind || ':' || new.record_id || ':' || coalesce(new.item_kind, '') || ':' || coalesce(new.item_id::text, '') || ':' || coalesce(new.field, '');
begin
	select c.cause_kind into cause from change_sets c where c.id = new.change_set_id and c.organisation_id = new.organisation_id;
	if cause is distinct from 'reversal' then
		if new.reverses_change_id is not null then
			raise exception 'only a reversal''s changes reverse a change' using errcode = 'check_violation';
		end if;
		return new;
	end if;
	links := nullif(current_setting('app.reverses', true), '')::jsonb;
	wanted := links ->> key;
	if wanted is null then
		raise exception 'a reversal writes only the changes it names (no link for %)', key using errcode = 'check_violation';
	end if;
	select r.id, r.change_set_id, r.record_kind, r.record_id, r.item_kind, r.item_id, r.field, r.operation into target
		from record_changes r where r.organisation_id = new.organisation_id and r.id = wanted::uuid;
	if not found or target.change_set_id = new.change_set_id or target.record_kind <> new.record_kind or target.record_id <> new.record_id
		or target.item_kind is distinct from new.item_kind or target.item_id is distinct from new.item_id
		or (new.operation = 'update' and target.field is distinct from new.field)
		or (new.operation <> 'update' and target.operation = 'update') then
		raise exception 'a reversal links each change to an earlier change of the same field or item' using errcode = 'check_violation';
	end if;
	new.reverses_change_id := target.id;
	return new;
end $$;
create trigger record_changes_reverses before insert on record_changes for each row execute function record_changes_reverses();

-- 2. Topic to task ----------------------------------------------------------------------------------------------------

-- The one path by which a thread changes kind. The caller has opened this transaction's change set (the task insert is
-- journalled, so journal_guard refuses it otherwise) and holds nothing it needs: the function takes the caller's
-- membership, then the thread, in the global lock order. Returns the new task's id.
create function thread_make_task(p_thread uuid, p_owner uuid, p_due date, p_expected_revision integer) returns uuid
	language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
	org uuid := current_organisation_id();
	me uuid := current_user_id();
	thread record;
	task uuid := uuidv7();
	next_revision integer;
begin
	if org is null or me is null or p_thread is null then
		raise exception 'making a task needs a person in an organisation' using errcode = 'insufficient_privilege';
	end if;
	perform 1 from memberships where organisation_id = org and user_id = me and status = 'active' for share;
	if not found then
		raise exception 'making a task needs an active membership' using errcode = 'insufficient_privilege';
	end if;
	if p_owner is not null then
		perform 1 from memberships where organisation_id = org and user_id = p_owner and status = 'active' for share;
		if not found then
			raise exception 'a task''s owner is an active member' using errcode = 'check_violation';
		end if;
	end if;
	select t.id, t.kind, t.title, t.revision into thread from threads t where t.id = p_thread and t.organisation_id = org for update;
	-- Invisible and absent are the same answer.
	if not found or not thread_visible(p_thread) then
		raise exception 'that thread is not available' using errcode = 'insufficient_privilege';
	end if;
	if thread.kind <> 'topic' then
		raise exception 'only a topic thread becomes a task' using errcode = 'check_violation';
	end if;
	if thread.revision is distinct from p_expected_revision then
		raise exception 'the thread changed since it was read' using errcode = 'serialization_failure';
	end if;
	perform set_config('app.topic_task_id', task::text, true);
	insert into tasks (id, organisation_id, parent_id, title, body, status, owner_id, due, source_kind, source_id, created_by)
		values (task, org, null, thread.title, '', 'open', p_owner, p_due, 'person', me::text, me);
	update threads set kind = 'record', task_id = task, title = null, create_fingerprint = null, revision = revision + 1
		where id = p_thread returning revision into next_revision;
	perform set_config('app.topic_task_id', '', true);
	insert into chat_audit_events (organisation_id, thread_id, actor_id, action, subject_kind, subject_id, detail)
		values (org, p_thread, me, 'chat.thread_updated', 'thread', p_thread,
			jsonb_build_object('threadId', p_thread, 'revision', next_revision, 'taskId', task));
	return task;
end $$;

-- 0046's record-thread trigger, unchanged except that the task thread_make_task inserts gets no thread of its own: that
-- function gives it the topic's. Only that function (running as its owner) can name such a task.
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
		insert into threads (organisation_id, kind, reservation_id, created_by) values (new.organisation_id, 'record', new.id, current_user_id());
	elsif tg_table_name = 'stock_items' then
		insert into threads (organisation_id, kind, stock_item_id, created_by) values (new.organisation_id, 'record', new.id, current_user_id());
	else
		raise exception 'thread_for_record does not know table %', tg_table_name;
	end if;
	return null;
end $$;

-- 0046's thread guard with one more update path: a topic becoming its new task's record thread, inside thread_make_task.
create or replace function thread_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare me uuid := current_user_id();
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
		-- Topic to task: only inside thread_make_task, for the task it has just inserted, keeping everything but the
		-- title and fingerprint (a record thread has neither) and moving the revision once.
		if current_user is distinct from (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = 'public.thread_make_task(uuid, uuid, date, integer)'::regprocedure)
			or new.task_id is null or new.task_id::text is distinct from current_setting('app.topic_task_id', true)
			or new.reservation_id is not null or new.stock_item_id is not null or new.title is not null or new.create_fingerprint is not null
			or new.id <> old.id or new.organisation_id <> old.organisation_id or new.created_at <> old.created_at or new.created_by is distinct from old.created_by
			or new.last_seq <> old.last_seq or new.last_change <> old.last_change or new.last_message_at is distinct from old.last_message_at
			or new.revision <> old.revision + 1 then
			raise exception 'a topic becomes a task only through thread_make_task' using errcode = 'check_violation';
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

revoke all on function record_changes_reverses(), thread_make_task(uuid, uuid, date, integer) from public;
grant execute on function thread_make_task(uuid, uuid, date, integer) to app, captain_runtime;
