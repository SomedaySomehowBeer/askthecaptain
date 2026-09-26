-- Linked chat, PR C (D25; docs/plans/linked-chat-2026-09.md §4, §5, §8, §9.3, §9.4, §13): shared message pins,
-- personal stars and read positions, and author edits. Additive to 0042, which is not edited: its two guard functions
-- that gain PR C rules (messages, participants) are replaced here in full, keeping every PR B rule.
--
-- Roles (D6): every policy and grant names the runtime `captain_runtime` and, at parity, legacy `app`. The new trigger
-- functions are security invoker, revoked from public and granted to nobody. No new definer function: the three
-- callable functions of §9.2 and 0042's commit-time seq check stay the only elevated paths.
--
-- Read starting positions (§13) are a participation baseline on the participant row, `read_start_seq`, set by the
-- invoker participant trigger on create, add and re-add, in the same transaction. Nobody writes another person's
-- private read row. A person's effective read position is max(read_start_seq, their own last_read_seq, or 0).
--
-- Shared change numbers (§9.4): messages and pins draw change_seq from the conversation's last_change. Each table's
-- own unique index keeps a number from being held twice within it; the invoker guards refuse a number the other table
-- already holds in the same conversation. Old numbers are not kept: an edit or unpin replaces its row's number, and
-- the change feed tolerates those gaps (§8).

-- §9.1: the owner must see every row. Refuse rather than install broken policies and functions.
do $$ begin
	if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
		raise exception 'migration 0043 must run as a role that bypasses row security (the migration owner)';
	end if;
end $$;

-- D6: the same check as 0042, against the role the API connects as. This changes no role.
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
	if problems is null then raise exception 'migration 0043 requires the runtime role % (created by 0041_runtime_role)', runtime; end if;
	if cardinality(problems) > 0 then
		raise exception 'runtime role % is not safe for row security: %', runtime, array_to_string(problems, ', ');
	end if;
end $$;
-- runtime-role precondition: end

-- Tables -------------------------------------------------------------------------------------------------------

create table message_pins (
	id uuid primary key default uuidv7(), -- server identity: a retried pin is 409 message_already_pinned, never a match
	organisation_id uuid not null references organisations(id) on delete cascade,
	conversation_id uuid not null,
	message_id uuid not null, -- references the message; its text is never copied
	change_seq integer not null, -- this pin's latest change in the conversation's change feed
	pinned_by uuid,
	pinned_at timestamptz not null default now(),
	unpinned_by uuid,
	unpinned_at timestamptz,
	foreign key (organisation_id, conversation_id) references conversations(organisation_id, id) on delete cascade,
	foreign key (organisation_id, message_id) references messages(organisation_id, id) on delete cascade,
	foreign key (organisation_id, pinned_by) references memberships(organisation_id, user_id) on delete set null (pinned_by),
	foreign key (organisation_id, unpinned_by) references memberships(organisation_id, user_id) on delete set null (unpinned_by),
	constraint message_pins_change_check check (change_seq > 0),
	-- unpinned_by names who unpinned; Rule A may later null it, never unpinned_at.
	constraint message_pins_unpinned_check check (unpinned_by is null or unpinned_at is not null)
);
-- §9.4 maps exactly this name to 409 message_already_pinned: at most one live pin per message.
create unique index message_pins_live_message on message_pins (message_id) where unpinned_at is null;
create unique index message_pins_conversation_change on message_pins (conversation_id, change_seq);
create index message_pins_live_by_conversation on message_pins (organisation_id, conversation_id) where unpinned_at is null;

create table conversation_stars (
	organisation_id uuid not null references organisations(id) on delete cascade,
	conversation_id uuid not null,
	user_id uuid not null,
	created_at timestamptz not null default now(),
	primary key (conversation_id, user_id),
	foreign key (organisation_id, conversation_id) references conversations(organisation_id, id) on delete cascade,
	-- Personal: deleting the membership (account or organisation deletion) deletes the star (§12).
	foreign key (organisation_id, user_id) references memberships(organisation_id, user_id) on delete cascade
);
create index conversation_stars_by_user on conversation_stars (organisation_id, user_id);

create table conversation_reads (
	organisation_id uuid not null references organisations(id) on delete cascade,
	conversation_id uuid not null,
	user_id uuid not null,
	last_read_seq integer not null, -- this person's own furthest displayed message; never a read receipt
	updated_at timestamptz not null default now(),
	primary key (conversation_id, user_id),
	foreign key (organisation_id, conversation_id) references conversations(organisation_id, id) on delete cascade,
	foreign key (organisation_id, user_id) references memberships(organisation_id, user_id) on delete cascade,
	constraint conversation_reads_seq_check check (last_read_seq >= 0)
);

-- The participation baseline (§13). Backfilled below for every existing participant to the conversation's current
-- last_seq, so nobody sees their whole history as unread. Only this one owner-run statement bypasses the participant
-- trigger, inside this migration's transaction.
alter table conversation_participants add column read_start_seq integer not null default 0;
alter table conversation_participants add constraint conversation_participants_read_start_check check (read_start_seq >= 0);
alter table conversation_participants disable trigger conversation_participants_guard;
update conversation_participants p set read_start_seq = c.last_seq from conversations c where c.id = p.conversation_id;
alter table conversation_participants enable trigger conversation_participants_guard;

-- §9.4 row-transition triggers (security invoker) ----------------------------------------------------------------

-- Replaces 0042's function. Unchanged: Rule A, the bootstrap and add rules, leave, removal and re-add. New: the
-- baseline is the conversation's current last_seq on insert and re-add, whatever the caller supplied, and no other
-- update may change it.
create or replace function chat_participants_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	me uuid := current_user_id();
	conv record;
	caller_participates boolean;
begin
	if tg_op = 'INSERT' then
		select c.created_by, c.last_seq into conv from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id;
		if not found then
			return new; -- invisible or absent: row security (or the foreign key, for the owner) refuses it
		end if;
		if me is null or new.state <> 'active' or new.ended_at is not null or new.added_by is distinct from me
			or not exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = new.user_id and m.status = 'active') then
			raise exception 'only an active member can be added, by the person adding them' using errcode = 'check_violation';
		end if;
		select exists (select 1 from conversation_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
			where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active' and m.status = 'active') into caller_participates;
		new.added_at := now(); -- server time, never the caller's
		new.read_start_seq := conv.last_seq; -- the participation baseline, never the caller's
		if caller_participates then
			return new;
		end if;
		-- The bootstrap row: the creator adding themselves to a conversation that has no participants yet.
		if new.user_id = me and conv.created_by = me
			and not exists (select 1 from conversation_participants p where p.conversation_id = new.conversation_id) then
			return new;
		end if;
		raise exception 'only a participant can add people to a conversation' using errcode = 'check_violation';
	end if;
	if (to_jsonb(new) - 'added_by') = (to_jsonb(old) - 'added_by')
		and (new.added_by is not distinct from old.added_by or (new.added_by is null
			and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.added_by))) then
		return new;
	end if;
	if new.organisation_id <> old.organisation_id or new.conversation_id <> old.conversation_id or new.user_id <> old.user_id then
		raise exception 'a participant row keeps its conversation and person' using errcode = 'check_violation';
	end if;
	-- Timestamps of these transitions are the server's: ended_at when access ends, added_at when someone is re-added.
	if old.state = 'active' and new.state = 'left' then
		if new.user_id = me and new.added_by is not distinct from old.added_by and new.added_at = old.added_at
			and new.read_start_seq = old.read_start_seq then
			new.ended_at := now();
			return new;
		end if;
	elsif old.state = 'active' and new.state = 'removed' then
		if new.added_by is not distinct from old.added_by and new.added_at = old.added_at and new.read_start_seq = old.read_start_seq and (
			-- An owner or admin who participates removes someone else.
			(new.user_id <> me
				and exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = me
					and m.status = 'active' and m.role in ('owner', 'admin'))
				and exists (select 1 from conversation_participants p where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active'))
			-- chat_end_membership: the person's membership is already removed, so they have already lost access.
			or (exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = new.user_id and m.status = 'removed'))) then
			new.ended_at := now();
			return new;
		end if;
	elsif old.state in ('left', 'removed') and new.state = 'active' then
		-- Re-add: only an explicit add of an active member by another active participant.
		if new.user_id <> me and new.added_by = me
			and exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = new.user_id and m.status = 'active')
			and exists (select 1 from conversation_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
				where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active' and m.status = 'active') then
			select c.last_seq into conv from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id;
			new.added_at := now();
			new.ended_at := null;
			-- A fresh baseline: an older private read row cannot turn the time away into a flood of unread messages.
			new.read_start_seq := conv.last_seq;
			return new;
		end if;
	end if;
	raise exception 'that participant change is not allowed' using errcode = 'check_violation';
end $$;

-- Replaces 0042's function. Unchanged: the send and tombstone rules and Rule A. New: the author's edit, and every
-- change number a message takes must not be held by a pin in the same conversation.
create or replace function chat_messages_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	me uuid := current_user_id();
	counters record;
begin
	if tg_op = 'INSERT' then
		select c.last_seq, c.last_change, c.last_message_at into counters from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id;
		if not found then
			return new; -- invisible or absent: row security refuses it
		end if;
		if me is null or new.author_id is distinct from me or not exists (
			select 1 from conversation_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
			where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active' and m.status = 'active') then
			raise exception 'only a participant sends, as themselves' using errcode = 'check_violation';
		end if;
		if new.seq <> counters.last_seq or new.change_seq <> counters.last_change then
			raise exception 'a message takes the conversation''s newly advanced counters' using errcode = 'check_violation';
		end if;
		if new.body is null or new.sent_body_sha256 is null or new.deleted_at is not null or new.deleted_by is not null
			or new.edited_at is not null or new.revision <> 1 then
			raise exception 'a message is sent live, unedited, at revision 1' using errcode = 'check_violation';
		end if;
		if exists (select 1 from message_pins mp where mp.conversation_id = new.conversation_id and mp.change_seq = new.change_seq) then
			raise exception 'that change number is already held by a pin' using errcode = 'check_violation';
		end if;
		-- Server time, taken from the send's own counter update, so created_at never decreases along seq.
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
	if old.deleted_at is not null then
		raise exception 'a deleted message cannot be changed' using errcode = 'check_violation';
	end if;
	if new.id <> old.id or new.organisation_id <> old.organisation_id or new.conversation_id <> old.conversation_id
		or new.seq <> old.seq or new.created_at <> old.created_at or new.author_id is distinct from old.author_id then
		raise exception 'a message keeps its identity, place and author' using errcode = 'check_violation';
	end if;
	select c.last_change into counters from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id;
	if not found then
		raise exception 'that message change is not allowed' using errcode = 'check_violation';
	end if;
	if exists (select 1 from message_pins mp where mp.conversation_id = new.conversation_id and mp.change_seq = new.change_seq) then
		raise exception 'that change number is already held by a pin' using errcode = 'check_violation';
	end if;
	-- Tombstone: by the author, or by an owner or admin who participates (row security required participation).
	-- The only change a moderator can make to someone else's message; its body can never be replaced.
	if new.deleted_at is not null
		and (me = old.author_id or exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = me
			and m.status = 'active' and m.role in ('owner', 'admin')))
		and exists (select 1 from conversation_participants p where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active')
		and new.body is null and new.sent_body_sha256 is null and new.deleted_by = me and new.revision = old.revision + 1
		and new.change_seq = counters.last_change and new.change_seq > old.change_seq
		and new.edited_at is not distinct from old.edited_at then
		new.deleted_at := now(); -- server time, never the caller's
		return new;
	end if;
	-- Author edit (§5, §9.4): the author alone, while participating, replaces the body. The original hash stays, so a
	-- send retry still matches after an edit; no history is kept. A body the same as before is not an edit.
	if new.deleted_at is null and me = old.author_id
		and exists (select 1 from conversation_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
			where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active' and m.status = 'active')
		and new.body is not null and new.body <> old.body and new.sent_body_sha256 = old.sent_body_sha256 and new.deleted_by is null
		and new.revision = old.revision + 1 and new.change_seq = counters.last_change and new.change_seq > old.change_seq then
		new.edited_at := now(); -- server time, never the caller's
		return new;
	end if;
	raise exception 'that message change is not allowed' using errcode = 'check_violation';
end $$;

create function chat_pins_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	me uuid := current_user_id();
	counters record;
	target record;
	participates boolean;
begin
	if tg_op = 'INSERT' then
		select c.last_change into counters from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id;
		if not found then
			return new; -- invisible or absent: row security refuses it (no existence oracle)
		end if;
		if me is null or new.pinned_by is distinct from me or not exists (
			select 1 from conversation_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
			where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active' and m.status = 'active') then
			raise exception 'only a participant pins, as themselves' using errcode = 'check_violation';
		end if;
		-- The same refusal whether the named message is elsewhere or does not exist.
		select m.conversation_id, m.deleted_at into target from messages m where m.organisation_id = new.organisation_id and m.id = new.message_id;
		if not found or target.conversation_id <> new.conversation_id then
			raise exception 'a pin names a message in its own conversation' using errcode = 'check_violation';
		end if;
		if target.deleted_at is not null then
			raise exception 'a deleted message cannot be pinned' using errcode = 'check_violation';
		end if;
		if new.unpinned_at is not null or new.unpinned_by is not null then
			raise exception 'a pin starts live' using errcode = 'check_violation';
		end if;
		if new.change_seq <> counters.last_change then
			raise exception 'a pin takes the conversation''s newly advanced change number' using errcode = 'check_violation';
		end if;
		if exists (select 1 from messages m where m.conversation_id = new.conversation_id and m.change_seq = new.change_seq) then
			raise exception 'that change number is already held by a message' using errcode = 'check_violation';
		end if;
		new.pinned_at := now(); -- server time, never the caller's
		return new;
	end if;
	-- Rule A on either attribution column.
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
	if new.id <> old.id or new.organisation_id <> old.organisation_id or new.conversation_id <> old.conversation_id
		or new.message_id <> old.message_id or new.pinned_by is distinct from old.pinned_by or new.pinned_at <> old.pinned_at then
		raise exception 'a pin keeps its identity, message and pinner' using errcode = 'check_violation';
	end if;
	select c.last_change into counters from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id;
	if not found then
		raise exception 'that pin change is not allowed' using errcode = 'check_violation';
	end if;
	select exists (select 1 from conversation_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
		where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active' and m.status = 'active') into participates;
	-- Live to unpinned: any participant, as themselves, with a fresh change number no message holds.
	if participates and new.unpinned_at is not null and new.unpinned_by = me
		and new.change_seq = counters.last_change and new.change_seq > old.change_seq
		and not exists (select 1 from messages m where m.conversation_id = new.conversation_id and m.change_seq = new.change_seq) then
		new.unpinned_at := now(); -- server time, never the caller's
		return new;
	end if;
	raise exception 'that pin change is not allowed' using errcode = 'check_violation';
end $$;

create function chat_stars_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
	if tg_op = 'INSERT' then
		if not exists (select 1 from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id) then
			return new; -- invisible or absent: row security refuses it
		end if;
		if current_user_id() is null or new.user_id is distinct from current_user_id() then
			raise exception 'a star is set by its own person' using errcode = 'check_violation';
		end if;
		new.created_at := now(); -- server time, never the caller's
		return new;
	end if;
	raise exception 'a star is set or cleared, never changed' using errcode = 'check_violation';
end $$;

create function chat_reads_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare latest integer;
begin
	select c.last_seq into latest from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id;
	if tg_op = 'INSERT' then
		if latest is null then
			return new; -- invisible or absent: row security refuses it
		end if;
		if current_user_id() is null or new.user_id is distinct from current_user_id() then
			raise exception 'a read position is written by its own person' using errcode = 'check_violation';
		end if;
		if new.last_read_seq < 0 or new.last_read_seq > latest then
			raise exception 'a read position is between 0 and the latest message' using errcode = 'check_violation';
		end if;
		new.updated_at := now(); -- server time, never the caller's
		return new;
	end if;
	if new.organisation_id <> old.organisation_id or new.conversation_id <> old.conversation_id or new.user_id <> old.user_id
		or current_user_id() is distinct from old.user_id then
		raise exception 'a read position belongs to one person in one conversation' using errcode = 'check_violation';
	end if;
	if latest is null or new.last_read_seq <= old.last_read_seq or new.last_read_seq > latest then
		raise exception 'a read position only advances, up to the latest message' using errcode = 'check_violation';
	end if;
	new.updated_at := now();
	return new;
end $$;

create trigger message_pins_guard before insert or update on message_pins for each row execute function chat_pins_guard();
create trigger conversation_stars_guard before insert or update on conversation_stars for each row execute function chat_stars_guard();
create trigger conversation_reads_guard before insert or update on conversation_reads for each row execute function chat_reads_guard();

-- §9.3 row security (all `to app, captain_runtime`) --------------------------------------------------------------

alter table message_pins enable row level security;
alter table message_pins force row level security;
create policy message_pins_select on message_pins for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id));
create policy message_pins_insert on message_pins for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and chat_participant(conversation_id) and pinned_by = current_user_id());
create policy message_pins_update on message_pins for update to app, captain_runtime
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id))
	with check (organisation_id = current_organisation_id());

-- Personal rows: visible only to their own person, and only while that person participates.
alter table conversation_stars enable row level security;
alter table conversation_stars force row level security;
create policy conversation_stars_select on conversation_stars for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id) and user_id = current_user_id());
create policy conversation_stars_insert on conversation_stars for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and chat_participant(conversation_id) and user_id = current_user_id());
create policy conversation_stars_delete on conversation_stars for delete to app, captain_runtime
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id) and user_id = current_user_id());

alter table conversation_reads enable row level security;
alter table conversation_reads force row level security;
create policy conversation_reads_select on conversation_reads for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id) and user_id = current_user_id());
create policy conversation_reads_insert on conversation_reads for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and chat_participant(conversation_id) and user_id = current_user_id());
create policy conversation_reads_update on conversation_reads for update to app, captain_runtime
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id) and user_id = current_user_id())
	with check (organisation_id = current_organisation_id() and user_id = current_user_id());

-- Grants: pins are never deleted (unpinning is an update); stars are set and cleared; reads only advance.
grant select, insert, update on message_pins to app, captain_runtime;
grant select, insert, delete on conversation_stars to app, captain_runtime;
grant select, insert, update on conversation_reads to app, captain_runtime;

-- Trigger functions are never callable. The two replaced functions keep 0042's revocation; restated so this file
-- stands on its own.
revoke all on function chat_participants_guard(), chat_messages_guard(), chat_pins_guard(), chat_stars_guard(), chat_reads_guard() from public;
