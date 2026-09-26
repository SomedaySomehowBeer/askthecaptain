-- Linked chat, PR B (D25; docs/plans/linked-chat-2026-09.md, adopted in #160): conversations, participants,
-- task/project links, messages and participant-scoped chat audit. Pins, stars and read positions are PR C.
--
-- Access is an active participant row plus an active membership, checked by chat_participant() in every policy.
-- Every person's write is checked here, in the database: row security decides who may touch a row, and one
-- `before insert or update` trigger per table decides which transitions are allowed (§9.4). The three callable
-- `security definer` functions are the only elevated paths. Chat writes are audited in chat_audit_events, never in
-- the tenant-wide audit_events (AGENTS "Writes are plain writes", plan D25).

-- §9.1: the definer functions and the owner-run referential actions must see every row. Under forced row
-- security a non-bypassing owner would be filtered, so refuse to run rather than install broken functions.
do $$ begin
	if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
		raise exception 'migration 0041 must run as a role that bypasses row security (the migration owner)';
	end if;
end $$;

-- D6: chat access is enforced only by policies `to app`, so the runtime role must not bypass row security, directly
-- or by switching into a role that does, and must not administer roles. A deployment has run with it otherwise
-- (staging, 2026-09-26). Refuse rather than install chat behind policies that would not apply. This changes no role.
-- runtime-role precondition: begin
do $$ declare runtime constant name := 'app'; problems text[];
begin
	select array_remove(array[
		case when r.rolsuper then 'superuser' end,
		case when r.rolbypassrls then 'bypassrls' end,
		case when r.rolcreaterole then 'createrole' end,
		case when exists (select 1 from pg_roles o where o.oid <> r.oid and (o.rolsuper or o.rolbypassrls)
			and pg_has_role(r.oid, o.oid, 'SET')) then 'can set role to a role that bypasses row security' end], null)
	into problems from pg_roles r where r.rolname = runtime;
	if problems is null then raise exception 'migration 0041 requires the runtime role %', runtime; end if;
	if cardinality(problems) > 0 then
		raise exception 'runtime role % must not bypass row security: %', runtime, array_to_string(problems, ', ');
	end if;
end $$;
-- runtime-role precondition: end

-- Tables -------------------------------------------------------------------------------------------------------

create table conversations (
	id uuid primary key, -- client-generated create identity
	organisation_id uuid not null references organisations(id) on delete cascade,
	title text not null,
	create_fingerprint bytea not null, -- sha256 of the normalised original create request; never changes
	created_by uuid, -- attribution only: no lasting power
	last_seq integer not null default 0,
	last_change integer not null default 0,
	last_message_at timestamptz,
	revision integer not null default 1,
	created_at timestamptz not null default now(),
	constraint conversations_organisation_id_id_key unique (organisation_id, id),
	foreign key (organisation_id, created_by) references memberships(organisation_id, user_id) on delete set null (created_by),
	constraint conversations_title_check check (title = btrim(title) and char_length(title) between 1 and 80),
	constraint conversations_fingerprint_check check (octet_length(create_fingerprint) = 32),
	constraint conversations_counters_check check (last_seq >= 0 and last_change >= last_seq and revision > 0)
);
create index conversations_by_activity on conversations (organisation_id, last_message_at desc nulls last, id);

create table conversation_participants (
	organisation_id uuid not null references organisations(id) on delete cascade,
	conversation_id uuid not null,
	user_id uuid not null,
	state text not null default 'active',
	added_by uuid,
	added_at timestamptz not null default now(),
	ended_at timestamptz,
	primary key (conversation_id, user_id),
	foreign key (organisation_id, conversation_id) references conversations(organisation_id, id) on delete cascade,
	-- Deleting the membership (account or organisation deletion) removes the person's participation.
	foreign key (organisation_id, user_id) references memberships(organisation_id, user_id) on delete cascade,
	foreign key (organisation_id, added_by) references memberships(organisation_id, user_id) on delete set null (added_by),
	constraint conversation_participants_state_check check (state in ('active', 'left', 'removed')),
	constraint conversation_participants_ended_check check ((state = 'active') = (ended_at is null))
);
create index conversation_participants_active_by_user on conversation_participants (organisation_id, user_id, conversation_id) where state = 'active';

create table conversation_links (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	conversation_id uuid not null,
	target_kind text not null,
	task_id uuid,
	project_id uuid,
	linked_by uuid,
	created_at timestamptz not null default now(),
	foreign key (organisation_id, conversation_id) references conversations(organisation_id, id) on delete cascade,
	foreign key (organisation_id, task_id) references tasks(organisation_id, id) on delete cascade,
	foreign key (organisation_id, project_id) references projects(organisation_id, id) on delete cascade,
	foreign key (organisation_id, linked_by) references memberships(organisation_id, user_id) on delete set null (linked_by),
	constraint conversation_links_target_check check ((target_kind = 'task' and task_id is not null and project_id is null)
		or (target_kind = 'project' and project_id is not null and task_id is null))
);
create unique index conversation_links_target on conversation_links (conversation_id, target_kind, coalesce(task_id, project_id));
create index conversation_links_by_task on conversation_links (organisation_id, task_id) where task_id is not null;
create index conversation_links_by_project on conversation_links (organisation_id, project_id) where project_id is not null;

create table messages (
	id uuid primary key, -- client-generated send identity
	organisation_id uuid not null references organisations(id) on delete cascade,
	conversation_id uuid not null,
	seq integer not null, -- dense, gap-free, immutable display order
	change_seq integer not null, -- this row's latest change in the conversation's change feed
	author_id uuid,
	body text,
	sent_body_sha256 bytea, -- the original body's hash, kept while the message is live (send retries)
	created_at timestamptz not null default now(),
	edited_at timestamptz,
	deleted_at timestamptz,
	deleted_by uuid,
	revision integer not null default 1,
	-- Composite key for the PR C pin foreign keys; also an ID-collision constraint the API maps to its generic 409.
	constraint messages_organisation_id_id_key unique (organisation_id, id),
	constraint messages_conversation_seq unique (conversation_id, seq),
	constraint messages_conversation_change unique (conversation_id, change_seq),
	foreign key (organisation_id, conversation_id) references conversations(organisation_id, id) on delete cascade,
	foreign key (organisation_id, author_id) references memberships(organisation_id, user_id) on delete set null (author_id),
	foreign key (organisation_id, deleted_by) references memberships(organisation_id, user_id) on delete set null (deleted_by),
	constraint messages_counters_check check (seq > 0 and change_seq > 0 and revision > 0),
	constraint messages_body_check check (body is null or (char_length(body) between 1 and 4000 and octet_length(body) <= 16384)),
	constraint messages_hash_check check (sent_body_sha256 is null or octet_length(sent_body_sha256) = 32),
	-- A live message has its body and hash; a content-free tombstone has neither (deleted_by may later be nulled).
	constraint messages_tombstone_check check ((deleted_at is null and body is not null and sent_body_sha256 is not null and deleted_by is null)
		or (deleted_at is not null and body is null and sent_body_sha256 is null))
);

create table chat_audit_events (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	conversation_id uuid not null,
	actor_id uuid,
	action text not null,
	subject_kind text not null,
	subject_id uuid,
	personal boolean not null default false,
	request_id text,
	detail jsonb not null default '{}'::jsonb, -- IDs and counters only: never titles, bodies or names
	created_at timestamptz not null default now(),
	foreign key (organisation_id, conversation_id) references conversations(organisation_id, id) on delete cascade,
	foreign key (organisation_id, actor_id) references memberships(organisation_id, user_id) on delete set null (actor_id),
	constraint chat_audit_events_action_check check (action in ('chat.conversation_created', 'chat.conversation_updated',
		'chat.participant_added', 'chat.participant_removed', 'chat.participant_left', 'chat.link_added', 'chat.link_removed',
		'chat.message_sent', 'chat.message_edited', 'chat.message_deleted', 'chat.pin_added', 'chat.pin_removed',
		'chat.star_set', 'chat.star_cleared', 'chat.read_advanced')),
	constraint chat_audit_events_subject_check check (subject_kind in ('conversation', 'participant', 'link', 'message', 'pin', 'star', 'read')),
	constraint chat_audit_events_personal_check check (personal = (action in ('chat.star_set', 'chat.star_cleared', 'chat.read_advanced'))),
	constraint chat_audit_events_detail_check check (jsonb_typeof(detail) = 'object')
);
create index chat_audit_events_by_conversation on chat_audit_events (organisation_id, conversation_id, created_at, id);

-- §9.2 callable definer functions ------------------------------------------------------------------------------

-- The access predicate used by every chat policy. It takes no user argument: it can only say whether the current
-- person, in the current organisation, is an active participant with an active membership.
create function chat_participant(conversation_id uuid) returns boolean
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
	select exists (
		select 1 from conversation_participants p
		join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
		where p.conversation_id = $1 and p.organisation_id = current_organisation_id() and p.user_id = current_user_id()
			and p.state = 'active' and m.status = 'active')
$$;

-- The create bootstrap. It inserts the conversation and exactly one participant row, for the caller, and audits
-- the creation. An existing ID is 'matched' only for the same creator, still participating, with the same
-- fingerprint; anything else is 'unavailable', without saying which. It never updates an existing conversation.
create function chat_create_conversation(p_id uuid, p_title text, p_fingerprint bytea) returns text
	language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
	org uuid := current_organisation_id();
	me uuid := current_user_id();
	clean text := btrim(p_title);
	inserted uuid;
	constraint_hit text;
	existing record;
begin
	if org is null or me is null or p_id is null then
		raise exception 'chat create needs a person in an organisation' using errcode = 'insufficient_privilege';
	end if;
	-- §6: a no-op when the service already holds the create locks.
	perform 1 from memberships where organisation_id = org and user_id = me and status = 'active' for share;
	if not found then
		raise exception 'chat create needs an active membership' using errcode = 'insufficient_privilege';
	end if;
	if clean is null or char_length(clean) not between 1 and 80 then
		raise exception 'a conversation title has 1 to 80 characters' using errcode = 'check_violation';
	end if;
	if p_fingerprint is null or octet_length(p_fingerprint) <> 32 then
		raise exception 'a create fingerprint is 32 bytes' using errcode = 'check_violation';
	end if;
	begin
		insert into conversations (id, organisation_id, title, create_fingerprint, created_by)
			values (p_id, org, clean, p_fingerprint, me)
			on conflict (id) do nothing
			returning conversations.id into inserted;
	exception when unique_violation then
		-- A concurrent insert of the same ID can still hit the non-arbiter composite key. Only these exact
		-- constraints are an ID collision; anything else is a bug and propagates.
		get stacked diagnostics constraint_hit = constraint_name;
		if constraint_hit in ('conversations_pkey', 'conversations_organisation_id_id_key') then
			return 'unavailable';
		end if;
		raise;
	end;
	if inserted is not null then
		insert into conversation_participants (organisation_id, conversation_id, user_id, state, added_by)
			values (org, p_id, me, 'active', me);
		insert into chat_audit_events (organisation_id, conversation_id, actor_id, action, subject_kind, subject_id, detail)
			values (org, p_id, me, 'chat.conversation_created', 'conversation', p_id,
				jsonb_build_object('conversationId', p_id, 'revision', 1));
		return 'created';
	end if;
	select c.organisation_id, c.created_by, c.create_fingerprint into existing from conversations c where c.id = p_id;
	if found and existing.organisation_id = org and existing.created_by = me and existing.create_fingerprint = p_fingerprint
		and exists (select 1 from conversation_participants p where p.conversation_id = p_id and p.user_id = me and p.state = 'active') then
		return 'matched';
	end if;
	return 'unavailable';
end $$;

-- Ends a removed member's participation everywhere, for an owner or admin who need not be a participant (or for
-- the person themselves when they leave the organisation). It returns nothing, so no count or ID reaches a
-- caller who cannot see those conversations; the audit rows it writes are visible only to remaining participants.
create function chat_end_membership(p_target uuid) returns void
	language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
	org uuid := current_organisation_id();
	me uuid := current_user_id();
	caller_status text;
	caller_role text;
	target_status text;
	conv record;
	new_revision integer;
begin
	if org is null or me is null or p_target is null then
		raise exception 'chat membership end refused' using errcode = 'insufficient_privilege';
	end if;
	-- §6: the same rows and modes the service already holds, in user_id order, so nothing is upgraded.
	if me = p_target then
		select m.status into target_status from memberships m where m.organisation_id = org and m.user_id = p_target for no key update;
	elsif me < p_target then
		select m.status, m.role into caller_status, caller_role from memberships m where m.organisation_id = org and m.user_id = me for share;
		select m.status into target_status from memberships m where m.organisation_id = org and m.user_id = p_target for no key update;
	else
		select m.status into target_status from memberships m where m.organisation_id = org and m.user_id = p_target for no key update;
		select m.status, m.role into caller_status, caller_role from memberships m where m.organisation_id = org and m.user_id = me for share;
	end if;
	-- The target's membership must already be removed (in this organisation); the caller is that person, or an
	-- active owner or admin. Every refusal reads the same.
	if target_status is distinct from 'removed'
		or (me <> p_target and (caller_status is distinct from 'active' or caller_role is null or caller_role not in ('owner', 'admin'))) then
		raise exception 'chat membership end refused' using errcode = 'insufficient_privilege';
	end if;
	for conv in
		select c.id from conversations c
		where c.organisation_id = org and exists (select 1 from conversation_participants p
			where p.conversation_id = c.id and p.user_id = p_target and p.state = 'active')
		order by c.id
		for update
	loop
		update conversation_participants set state = 'removed', ended_at = now()
			where conversation_id = conv.id and user_id = p_target and state = 'active';
		update conversations set revision = revision + 1 where id = conv.id returning revision into new_revision;
		insert into chat_audit_events (organisation_id, conversation_id, actor_id, action, subject_kind, subject_id, detail)
			values (org, conv.id, me, 'chat.participant_removed', 'participant', p_target,
				jsonb_build_object('conversationId', conv.id, 'userId', p_target, 'revision', new_revision));
	end loop;
end $$;

-- §9.4 row-transition triggers -----------------------------------------------------------------------------------
-- Security invoker: under `app` they read memberships and the conversation through the tenant's own row security;
-- during referential actions they run as the table owner. They raise check_violation for anything not listed.
-- Each update check starts with Rule A: an update whose only changes null attribution columns of memberships that
-- no longer exist (the `on delete set null (column)` action) is allowed on any row and moves no counter.
-- An insert naming a conversation the caller cannot see is passed through so row security refuses it with the same
-- error whether or not the conversation exists (no existence oracle).

create function chat_conversations_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare me uuid := current_user_id();
begin
	if tg_op = 'INSERT' then
		if me is null or new.created_by is distinct from me or new.last_seq <> 0 or new.last_change <> 0 or new.revision <> 1
			or new.last_message_at is not null then
			raise exception 'a conversation starts empty, created by the person creating it' using errcode = 'check_violation';
		end if;
		new.created_at := now(); -- server time, never the caller's
		return new;
	end if;
	if (to_jsonb(new) - 'created_by') = (to_jsonb(old) - 'created_by')
		and (new.created_by is not distinct from old.created_by or (new.created_by is null
			and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.created_by))) then
		return new;
	end if;
	if new.id <> old.id or new.organisation_id <> old.organisation_id or new.create_fingerprint <> old.create_fingerprint
		or new.created_at <> old.created_at or new.created_by is distinct from old.created_by then
		raise exception 'a conversation keeps its identity, fingerprint and creator' using errcode = 'check_violation';
	end if;
	if new.last_seq not in (old.last_seq, old.last_seq + 1) or new.last_change not in (old.last_change, old.last_change + 1)
		or new.revision not in (old.revision, old.revision + 1) then
		raise exception 'conversation counters move by at most one' using errcode = 'check_violation';
	end if;
	if new.revision <> old.revision then
		-- Metadata, participant and link changes: revision only.
		if new.last_seq <> old.last_seq or new.last_change <> old.last_change or new.last_message_at is distinct from old.last_message_at then
			raise exception 'revision never moves with message counters' using errcode = 'check_violation';
		end if;
	else
		if new.title <> old.title then
			raise exception 'a title change moves the revision' using errcode = 'check_violation';
		end if;
		if new.last_seq <> old.last_seq then
			if new.last_change <> old.last_change + 1 then -- a send moves both message counters
				raise exception 'a send moves last_seq and last_change together' using errcode = 'check_violation';
			end if;
			-- Server time that never goes back: now() is the transaction's start, and a send that waited for the
			-- conversation lock may have started before the one that just committed. The message takes this value.
			new.last_message_at := greatest(old.last_message_at, now());
			-- Every seq has its message: checked when the transaction commits (conversations_seq_has_message).
		elsif new.last_message_at is distinct from old.last_message_at then
			raise exception 'last_message_at moves only with a send' using errcode = 'check_violation';
		end if;
	end if;
	return new;
end $$;

create function chat_participants_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	me uuid := current_user_id();
	creator uuid;
	caller_participates boolean;
begin
	if tg_op = 'INSERT' then
		select c.created_by into creator from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id;
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
		if caller_participates then
			return new;
		end if;
		-- The bootstrap row: the creator adding themselves to a conversation that has no participants yet.
		if new.user_id = me and creator = me
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
		if new.user_id = me and new.added_by is not distinct from old.added_by and new.added_at = old.added_at then
			new.ended_at := now();
			return new;
		end if;
	elsif old.state = 'active' and new.state = 'removed' then
		if new.added_by is not distinct from old.added_by and new.added_at = old.added_at and (
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
			new.added_at := now();
			new.ended_at := null;
			return new;
		end if;
	end if;
	raise exception 'that participant change is not allowed' using errcode = 'check_violation';
end $$;

create function chat_links_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare me uuid := current_user_id();
begin
	if tg_op = 'INSERT' then
		if not exists (select 1 from conversations c where c.id = new.conversation_id and c.organisation_id = new.organisation_id) then
			return new; -- invisible or absent: row security refuses it
		end if;
		if me is null or new.linked_by is distinct from me or not exists (
			select 1 from conversation_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
			where p.conversation_id = new.conversation_id and p.user_id = me and p.state = 'active' and m.status = 'active') then
			raise exception 'only a participant links work, as themselves' using errcode = 'check_violation';
		end if;
		new.created_at := now(); -- server time, never the caller's
		return new;
	end if;
	if (to_jsonb(new) - 'linked_by') = (to_jsonb(old) - 'linked_by') and new.linked_by is null and old.linked_by is not null
		and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.linked_by) then
		return new;
	end if;
	raise exception 'a link is created or removed, never changed' using errcode = 'check_violation';
end $$;

create function chat_messages_guard() returns trigger
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
	-- Author edits arrive in PR C (0042), which extends this function.
	raise exception 'that message change is not allowed' using errcode = 'check_violation';
end $$;

create function chat_audit_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
	if tg_op = 'INSERT' then
		if current_user_id() is null or new.actor_id is distinct from current_user_id() then
			raise exception 'chat audit records the person acting' using errcode = 'check_violation';
		end if;
		new.created_at := now(); -- the audit chronology is the server's, never the caller's
		return new;
	end if;
	if (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') and new.actor_id is null and old.actor_id is not null
		and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.actor_id) then
		return new;
	end if;
	raise exception 'chat audit is append-only' using errcode = 'check_violation';
end $$;

-- Every seq has its message (dense display order). The guards allow last_seq to move only by one, alongside
-- last_change, and a message insert must take the newly advanced number; this checks, when the transaction commits,
-- that each advance was used. One queued check per advance, each a primary-key-sized lookup on
-- messages_conversation_seq: several sends in one transaction each check their own number, an advance inside a
-- savepoint that rolled back is discarded with the savepoint, and a conversation deleted later in the transaction
-- (organisation deletion) has nothing left to check.
--
-- This is the one trigger that runs as its definer. Under `app`, row security would hide the conversation and its
-- messages from someone who advanced the counter and then left in the same transaction, so an invoker check could be
-- evaded exactly when it matters. It only reads and raises; it is not callable (not granted to app, revoked from
-- public) and changes nothing. The three callable definer functions of §9.2 remain the only elevated paths.
create function chat_conversations_seq_check() returns trigger
	language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
	if not exists (select 1 from conversations c where c.id = new.id) then
		return null; -- deleted later in this transaction: nothing remains to order
	end if;
	if not exists (select 1 from messages m where m.conversation_id = new.id and m.seq = new.last_seq) then
		raise exception 'every message number needs its message: a send advanced the counter without one' using errcode = 'check_violation';
	end if;
	return null;
end $$;

create trigger conversations_guard before insert or update on conversations for each row execute function chat_conversations_guard();
create constraint trigger conversations_seq_has_message after update on conversations
	deferrable initially deferred for each row
	when (new.last_seq is distinct from old.last_seq)
	execute function chat_conversations_seq_check();
create trigger conversation_participants_guard before insert or update on conversation_participants for each row execute function chat_participants_guard();
create trigger conversation_links_guard before insert or update on conversation_links for each row execute function chat_links_guard();
create trigger messages_guard before insert or update on messages for each row execute function chat_messages_guard();
create trigger chat_audit_events_guard before insert or update on chat_audit_events for each row execute function chat_audit_guard();

-- §9.3 row security (all `to app`) -------------------------------------------------------------------------------

alter table conversations enable row level security;
alter table conversations force row level security;
create policy conversations_select on conversations for select to app
	using (organisation_id = current_organisation_id() and chat_participant(id));
create policy conversations_update on conversations for update to app
	using (organisation_id = current_organisation_id() and chat_participant(id))
	with check (organisation_id = current_organisation_id());

alter table conversation_participants enable row level security;
alter table conversation_participants force row level security;
create policy conversation_participants_select on conversation_participants for select to app
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id));
create policy conversation_participants_insert on conversation_participants for insert to app
	with check (organisation_id = current_organisation_id() and chat_participant(conversation_id) and added_by = current_user_id());
create policy conversation_participants_update on conversation_participants for update to app
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id))
	with check (organisation_id = current_organisation_id());

alter table conversation_links enable row level security;
alter table conversation_links force row level security;
create policy conversation_links_select on conversation_links for select to app
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id));
create policy conversation_links_insert on conversation_links for insert to app
	with check (organisation_id = current_organisation_id() and chat_participant(conversation_id) and linked_by = current_user_id());
create policy conversation_links_delete on conversation_links for delete to app
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id));

alter table messages enable row level security;
alter table messages force row level security;
create policy messages_select on messages for select to app
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id));
create policy messages_insert on messages for insert to app
	with check (organisation_id = current_organisation_id() and chat_participant(conversation_id) and author_id = current_user_id());
create policy messages_update on messages for update to app
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id))
	with check (organisation_id = current_organisation_id());

alter table chat_audit_events enable row level security;
alter table chat_audit_events force row level security;
create policy chat_audit_events_select on chat_audit_events for select to app
	using (organisation_id = current_organisation_id() and chat_participant(conversation_id) and (not personal or actor_id = current_user_id()));
create policy chat_audit_events_insert on chat_audit_events for insert to app
	with check (organisation_id = current_organisation_id() and chat_participant(conversation_id) and actor_id = current_user_id());

-- Grants: no delete anywhere except unlinking; no insert on conversations (bootstrap only); audit is append-only.
grant select, update on conversations to app;
grant select, insert, update on conversation_participants to app;
grant select, insert, delete on conversation_links to app;
grant select, insert, update on messages to app;
grant select, insert on chat_audit_events to app;

revoke all on function chat_participant(uuid), chat_create_conversation(uuid, text, bytea), chat_end_membership(uuid),
	chat_conversations_guard(), chat_participants_guard(), chat_links_guard(), chat_messages_guard(), chat_audit_guard(),
	chat_conversations_seq_check() from public;
grant execute on function chat_participant(uuid), chat_create_conversation(uuid, text, bytea), chat_end_membership(uuid) to app;
