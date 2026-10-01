-- R2 threads (docs/plans/threads-2026-09.md, PR T-A; D7, D25, D27, D28): projects become tags, tags move onto
-- threads, every task, booking and stock item gets its record thread, and the thread model replaces the linked-chat
-- tables of 0042/0043. One transaction; the release runs it with HTTP stopped, as 0045 did.
--
-- The 0042/0043 chats are staging demo data (owner, 1 October 2026): their tables are dropped without copying, after
-- a notice with their row counts. chat_audit_events keeps its name (D25) and is recreated empty in its new shape.
-- Because the new chat_audit_events takes the old one's name, the old tables are dropped before the new ones are
-- created; every step is in this one transaction, so the order changes nothing a reader can see.
--
-- Access (contract §4): row security on every table, policies `to app, captain_runtime`, and one stable definer
-- predicate, thread_visible(thread_id), that the thread policies call. Every person's write is checked in the
-- database by one `before insert or update` guard per table, as in 0042/0043 (linked-chat §9.4); a caller-supplied
-- timestamp is ignored. The callable definer functions are thread_visible, thread_create (the topic/private create
-- bootstrap) and thread_end_membership; the commit-time sequence check is a non-callable definer trigger as before.
--
-- No CASCADE anywhere: an unknown dependency fails the migration instead of silently taking something with it.

-- §9.1 of the linked-chat contract: the definer functions and the owner-run referential actions must see every row.
do $$ begin
	if not exists (select 1 from pg_roles where rolname = current_user and (rolsuper or rolbypassrls)) then
		raise exception 'migration 0046 must run as a role that bypasses row security (the migration owner)';
	end if;
end $$;

-- D6: the thread tables are protected only by row security, so the runtime role must not be able to bypass it.
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
	if problems is null then raise exception 'migration 0046 requires the runtime role % (created by 0041_runtime_role)', runtime; end if;
	if cardinality(problems) > 0 then
		raise exception 'runtime role % is not safe for row security: %', runtime, array_to_string(problems, ', ');
	end if;
end $$;
-- runtime-role precondition: end

-- §8 step 1: hold what this changes. Nothing should hold these locks with HTTP stopped; fail within 30 s if something does.
set local lock_timeout = '30s';
lock table conversations, conversation_participants, conversation_links, messages, chat_audit_events,
	message_pins, conversation_stars, conversation_reads, projects, task_tags in access exclusive mode;
lock table tasks, task_series, equipment_reservations, stock_items in share row exclusive mode;
lock table tags, saved_views in share row exclusive mode;

-- Two projects whose names differ only in case cannot both become tags (the unique tag name stays). Refuse rather
-- than merge them by guesswork; the release gate counts projects, so this shows before the release, not during it.
do $$ declare shared integer; begin
	select count(*) into shared from (select 1 from projects group by organisation_id, lower(btrim(name)) having count(*) > 1) d;
	if shared > 0 then
		raise exception 'migration 0046 refused: % project names are used by more than one project in an organisation; rename them first. Nothing was changed', shared;
	end if;
end $$;

-- §8 step 5, done first for the shared name: the demo chats go, with a record of how many rows.
do $$ declare t text; n bigint; begin
	foreach t in array array['conversations', 'conversation_participants', 'conversation_links', 'messages', 'chat_audit_events',
		'message_pins', 'conversation_stars', 'conversation_reads'] loop
		execute format('select count(*) from public.%I', t) into n;
		raise notice 'migration 0046 drops %: % rows (0042/0043 demo chats, not copied)', t, n;
	end loop;
end $$;
drop table conversation_reads;
drop table conversation_stars;
drop table message_pins;
drop table chat_audit_events;
drop table messages;
drop table conversation_links;
drop table conversation_participants;
drop table conversations;
drop function chat_participant(uuid);
drop function chat_create_conversation(uuid, text, bytea);
drop function chat_end_membership(uuid);
drop function chat_conversations_guard();
drop function chat_participants_guard();
drop function chat_links_guard();
drop function chat_messages_guard();
drop function chat_audit_guard();
drop function chat_conversations_seq_check();
drop function chat_pins_guard();
drop function chat_stars_guard();
drop function chat_reads_guard();

-- Tags (amended, §3): a name, and optionally an owner and dates; archive, revision and attribution. The name limit
-- widens from 60 to 120 characters so every project name (the projects service allowed 120) fits unchanged.
alter table tags drop constraint tags_name_check;
alter table tags add constraint tags_name_check check (name = btrim(name) and length(name) between 1 and 120);
alter table tags
	add column owner_id uuid,
	add column starts_on date,
	add column ends_on date,
	add column archived_at timestamptz,
	add column revision integer not null default 1,
	add column created_by uuid;
alter table tags
	add constraint tags_revision_check check (revision > 0),
	add constraint tags_dates_check check (starts_on is null or ends_on is null or ends_on >= starts_on),
	add constraint tags_owner_fkey foreign key (organisation_id, owner_id) references memberships(organisation_id, user_id) on delete set null (owner_id),
	add constraint tags_created_by_fkey foreign key (organisation_id, created_by) references memberships(organisation_id, user_id) on delete set null (created_by);

-- Tables -------------------------------------------------------------------------------------------------------

create table threads (
	id uuid primary key default uuidv7(), -- client UUID for topic and private threads, server uuidv7 for record threads
	organisation_id uuid not null references organisations(id) on delete cascade,
	kind text not null,
	task_id uuid,
	reservation_id uuid,
	stock_item_id uuid,
	title text, -- topic and private only; a record thread's title is its record's, read at query time
	create_fingerprint bytea, -- topic and private only; sha256 of the normalised create request, never changes
	created_by uuid, -- attribution only: no lasting power
	last_seq integer not null default 0,
	last_change integer not null default 0,
	last_message_at timestamptz,
	revision integer not null default 1,
	created_at timestamptz not null default now(),
	constraint threads_organisation_id_id_key unique (organisation_id, id),
	foreign key (organisation_id, task_id) references tasks(organisation_id, id) on delete cascade,
	foreign key (organisation_id, reservation_id) references equipment_reservations(organisation_id, id) on delete cascade,
	foreign key (organisation_id, stock_item_id) references stock_items(organisation_id, id) on delete cascade,
	foreign key (organisation_id, created_by) references memberships(organisation_id, user_id) on delete set null (created_by),
	constraint threads_kind_check check (kind in ('record', 'topic', 'private')),
	constraint threads_shape_check check (
		(kind = 'record' and num_nonnulls(task_id, reservation_id, stock_item_id) = 1 and title is null and create_fingerprint is null)
		or (kind <> 'record' and num_nonnulls(task_id, reservation_id, stock_item_id) = 0 and title is not null and create_fingerprint is not null)),
	constraint threads_title_check check (title is null or (title = btrim(title) and char_length(title) between 1 and 80)),
	constraint threads_fingerprint_check check (create_fingerprint is null or octet_length(create_fingerprint) = 32),
	constraint threads_counters_check check (last_seq >= 0 and last_change >= last_seq and revision > 0)
);
-- A record has at most one thread.
create unique index threads_task on threads (task_id) where task_id is not null;
create unique index threads_reservation on threads (reservation_id) where reservation_id is not null;
create unique index threads_stock_item on threads (stock_item_id) where stock_item_id is not null;
create index threads_by_activity on threads (organisation_id, last_message_at desc nulls last, id desc);

create table thread_participants (
	organisation_id uuid not null references organisations(id) on delete cascade,
	thread_id uuid not null,
	user_id uuid not null,
	state text not null default 'active',
	added_by uuid,
	added_at timestamptz not null default now(),
	ended_at timestamptz,
	read_start_seq integer not null default 0, -- the participation baseline, set by the guard (linked-chat §13)
	primary key (thread_id, user_id),
	foreign key (organisation_id, thread_id) references threads(organisation_id, id) on delete cascade,
	foreign key (organisation_id, user_id) references memberships(organisation_id, user_id) on delete cascade,
	foreign key (organisation_id, added_by) references memberships(organisation_id, user_id) on delete set null (added_by),
	constraint thread_participants_state_check check (state in ('active', 'left', 'removed')),
	constraint thread_participants_ended_check check ((state = 'active') = (ended_at is null)),
	constraint thread_participants_read_start_check check (read_start_seq >= 0)
);
create index thread_participants_active_by_user on thread_participants (organisation_id, user_id, thread_id) where state = 'active';

-- The one place a tag is attached to anything. Deleting a tag removes its attachments; archiving keeps them.
create table thread_tags (
	organisation_id uuid not null references organisations(id) on delete cascade,
	thread_id uuid not null,
	tag_id uuid not null,
	attached_by uuid, -- null for the migration and for system-materialised series occurrences
	attached_at timestamptz not null default now(),
	primary key (thread_id, tag_id),
	foreign key (organisation_id, thread_id) references threads(organisation_id, id) on delete cascade,
	foreign key (organisation_id, tag_id) references tags(organisation_id, id) on delete cascade,
	foreign key (organisation_id, attached_by) references memberships(organisation_id, user_id) on delete set null (attached_by)
);
create index thread_tags_by_tag on thread_tags (organisation_id, tag_id, thread_id);

-- A series has no thread; each occurrence it creates receives these tags on its own thread (the materialiser, in code).
create table task_series_tags (
	organisation_id uuid not null references organisations(id) on delete cascade,
	series_id uuid not null,
	tag_id uuid not null,
	created_at timestamptz not null default now(),
	primary key (series_id, tag_id),
	foreign key (organisation_id, series_id) references task_series(organisation_id, id) on delete cascade,
	foreign key (organisation_id, tag_id) references tags(organisation_id, id) on delete cascade
);
create index task_series_tags_by_tag on task_series_tags (organisation_id, tag_id, series_id);

create table thread_messages (
	id uuid primary key, -- client-generated send identity
	organisation_id uuid not null references organisations(id) on delete cascade,
	thread_id uuid not null,
	kind text not null default 'message', -- R3 adds change lines and R5 approval cards; the R2 guard accepts only messages
	seq integer not null, -- dense, gap-free, immutable display order
	change_seq integer not null, -- this row's latest change in the thread's change feed
	author_id uuid,
	body text,
	sent_body_sha256 bytea, -- the original body's hash, kept while the message is live (send retries)
	created_at timestamptz not null default now(),
	edited_at timestamptz,
	deleted_at timestamptz,
	deleted_by uuid,
	revision integer not null default 1,
	constraint thread_messages_organisation_id_id_key unique (organisation_id, id),
	constraint thread_messages_thread_seq unique (thread_id, seq),
	constraint thread_messages_thread_change unique (thread_id, change_seq),
	foreign key (organisation_id, thread_id) references threads(organisation_id, id) on delete cascade,
	foreign key (organisation_id, author_id) references memberships(organisation_id, user_id) on delete set null (author_id),
	foreign key (organisation_id, deleted_by) references memberships(organisation_id, user_id) on delete set null (deleted_by),
	constraint thread_messages_kind_check check (kind in ('message', 'change', 'approval')),
	constraint thread_messages_counters_check check (seq > 0 and change_seq > 0 and revision > 0),
	constraint thread_messages_body_check check (body is null or (char_length(body) between 1 and 4000 and octet_length(body) <= 16384)),
	constraint thread_messages_hash_check check (sent_body_sha256 is null or octet_length(sent_body_sha256) = 32),
	constraint thread_messages_tombstone_check check ((deleted_at is null and body is not null and sent_body_sha256 is not null and deleted_by is null)
		or (deleted_at is not null and body is null and sent_body_sha256 is null))
);

create table thread_pins (
	id uuid primary key default uuidv7(), -- server identity
	organisation_id uuid not null references organisations(id) on delete cascade,
	thread_id uuid not null,
	message_id uuid not null, -- references the message; its text is never copied
	change_seq integer not null,
	pinned_by uuid,
	pinned_at timestamptz not null default now(),
	unpinned_by uuid,
	unpinned_at timestamptz,
	foreign key (organisation_id, thread_id) references threads(organisation_id, id) on delete cascade,
	foreign key (organisation_id, message_id) references thread_messages(organisation_id, id) on delete cascade,
	foreign key (organisation_id, pinned_by) references memberships(organisation_id, user_id) on delete set null (pinned_by),
	foreign key (organisation_id, unpinned_by) references memberships(organisation_id, user_id) on delete set null (unpinned_by),
	constraint thread_pins_change_check check (change_seq > 0),
	constraint thread_pins_unpinned_check check (unpinned_by is null or unpinned_at is not null)
);
-- The API maps exactly this name to 409 pin_exists: a thread has at most one live pin.
create unique index thread_pins_live on thread_pins (thread_id) where unpinned_at is null;
create unique index thread_pins_thread_change on thread_pins (thread_id, change_seq);

create table thread_stars (
	organisation_id uuid not null references organisations(id) on delete cascade,
	thread_id uuid not null,
	user_id uuid not null,
	created_at timestamptz not null default now(),
	primary key (thread_id, user_id),
	foreign key (organisation_id, thread_id) references threads(organisation_id, id) on delete cascade,
	foreign key (organisation_id, user_id) references memberships(organisation_id, user_id) on delete cascade
);
create index thread_stars_by_user on thread_stars (organisation_id, user_id);

create table thread_reads (
	organisation_id uuid not null references organisations(id) on delete cascade,
	thread_id uuid not null,
	user_id uuid not null,
	last_read_seq integer not null, -- this person's own furthest displayed message; never a read receipt
	updated_at timestamptz not null default now(),
	primary key (thread_id, user_id),
	foreign key (organisation_id, thread_id) references threads(organisation_id, id) on delete cascade,
	foreign key (organisation_id, user_id) references memberships(organisation_id, user_id) on delete cascade,
	constraint thread_reads_seq_check check (last_read_seq >= 0)
);

create table chat_audit_events (
	id uuid primary key default uuidv7(),
	organisation_id uuid not null references organisations(id) on delete cascade,
	thread_id uuid not null,
	actor_id uuid,
	action text not null,
	subject_kind text not null,
	subject_id uuid,
	personal boolean not null default false,
	request_id text,
	detail jsonb not null default '{}'::jsonb, -- IDs and counters only: never titles, bodies or names
	created_at timestamptz not null default now(),
	foreign key (organisation_id, thread_id) references threads(organisation_id, id) on delete cascade,
	foreign key (organisation_id, actor_id) references memberships(organisation_id, user_id) on delete set null (actor_id),
	constraint chat_audit_events_action_check check (action in ('chat.thread_created', 'chat.thread_updated',
		'chat.participant_added', 'chat.participant_removed', 'chat.participant_left',
		'chat.tag_added', 'chat.tag_removed', 'chat.message_sent', 'chat.message_edited', 'chat.message_deleted', 'chat.pin_added', 'chat.pin_removed',
		'chat.star_set', 'chat.star_cleared', 'chat.read_advanced')),
	constraint chat_audit_events_subject_check check (subject_kind in ('thread', 'participant', 'tag', 'message', 'pin', 'star', 'read')),
	constraint chat_audit_events_personal_check check (personal = (action in ('chat.star_set', 'chat.star_cleared', 'chat.read_advanced'))),
	constraint chat_audit_events_detail_check check (jsonb_typeof(detail) = 'object')
);
create index chat_audit_events_by_thread on chat_audit_events (organisation_id, thread_id, created_at, id);

-- §8 step 3: projects become tags. A project whose name matches a tag (case-insensitively) gives that tag its owner and
-- archive state and keeps the tag's id; any other becomes a tag with the project's id, name, owner, creator and times.
-- Projects hold no dates and their descriptions are not carried (§3). An owner or creator is carried only while they
-- hold a membership row in the organisation (a tag's owner is a membership); otherwise it is left empty.
create temporary table project_tags (project_id uuid primary key, organisation_id uuid not null, tag_id uuid not null unique) on commit drop;
insert into project_tags (project_id, organisation_id, tag_id)
	select p.id, p.organisation_id, t.id from projects p join tags t on t.organisation_id = p.organisation_id and lower(t.name) = lower(btrim(p.name));
update tags t set
	owner_id = case when exists (select 1 from memberships m where m.organisation_id = p.organisation_id and m.user_id = p.owner_id) then p.owner_id end,
	archived_at = p.archived_at, updated_at = now()
	from project_tags pt join projects p on p.id = pt.project_id where t.id = pt.tag_id;
insert into project_tags (project_id, organisation_id, tag_id)
	select p.id, p.organisation_id, p.id from projects p where not exists (select 1 from project_tags pt where pt.project_id = p.id);
insert into tags (id, organisation_id, name, owner_id, created_by, archived_at, created_at, updated_at)
	select p.id, p.organisation_id, btrim(p.name),
		case when exists (select 1 from memberships m where m.organisation_id = p.organisation_id and m.user_id = p.owner_id) then p.owner_id end,
		case when exists (select 1 from memberships m where m.organisation_id = p.organisation_id and m.user_id = p.created_by) then p.created_by end,
		p.archived_at, p.created_at, p.updated_at
	from projects p join project_tags pt on pt.project_id = p.id and pt.tag_id = p.id;
do $$ declare projects_in bigint; tags_written bigint; begin
	select count(*) into projects_in from projects;
	select count(*) into tags_written from project_tags pt join tags t on t.id = pt.tag_id;
	raise notice 'migration 0046: % projects became % tags (% matched an existing tag by name)', projects_in, tags_written,
		(select count(*) from project_tags where tag_id <> project_id);
	if projects_in <> tags_written then
		raise exception 'migration 0046: % projects but % tags written or updated', projects_in, tags_written;
	end if;
end $$;

-- A saved view naming a project that merged into a namesake tag now names that tag (saved views are dropped in R5).
update saved_views v set filter = jsonb_set(v.filter, '{projectId}', to_jsonb(pt.tag_id::text))
	from project_tags pt
	where v.deleted_at is null and v.filter ->> 'projectId' = pt.project_id::text and pt.tag_id <> pt.project_id;

-- §8 step 4: one record thread per top-level task, booking and stock item, with no activity yet.
insert into threads (organisation_id, kind, task_id) select organisation_id, 'record', id from tasks where parent_id is null order by created_at, id;
insert into threads (organisation_id, kind, reservation_id) select organisation_id, 'record', id from equipment_reservations order by created_at, id;
insert into threads (organisation_id, kind, stock_item_id) select organisation_id, 'record', id from stock_items order by created_at, id;

-- Tags move onto threads: task tags, a task's project and a booking's project each become one thread tag on that
-- record's thread (a task tagged with its own project's namesake counts once). A step's project is always its task's
-- (0038's trigger), so steps add nothing. A series' project becomes its series tag.
insert into thread_tags (organisation_id, thread_id, tag_id, attached_by, attached_at)
	select tt.organisation_id, th.id, tt.tag_id, tt.attached_by, tt.attached_at
	from task_tags tt join threads th on th.organisation_id = tt.organisation_id and th.task_id = tt.task_id;
insert into thread_tags (organisation_id, thread_id, tag_id)
	select t.organisation_id, th.id, pt.tag_id
	from tasks t join project_tags pt on pt.project_id = t.project_id join threads th on th.organisation_id = t.organisation_id and th.task_id = t.id
	where t.parent_id is null
	on conflict (thread_id, tag_id) do nothing;
insert into thread_tags (organisation_id, thread_id, tag_id)
	select r.organisation_id, th.id, pt.tag_id
	from equipment_reservations r join project_tags pt on pt.project_id = r.project_id join threads th on th.organisation_id = r.organisation_id and th.reservation_id = r.id;
insert into task_series_tags (organisation_id, series_id, tag_id, created_at)
	select s.organisation_id, s.id, pt.tag_id, s.created_at from task_series s join project_tags pt on pt.project_id = s.project_id;
do $$ declare
	records_in bigint; threads_written bigint; tags_in bigint; tags_written bigint; series_in bigint; series_written bigint;
begin
	select (select count(*) from tasks where parent_id is null) + (select count(*) from equipment_reservations) + (select count(*) from stock_items)
		into records_in;
	select count(*) into threads_written from threads where kind = 'record';
	select count(*) into tags_in from (
		select 'task' as kind, task_id as record, tag_id from task_tags
		union select 'task', t.id, pt.tag_id from tasks t join project_tags pt on pt.project_id = t.project_id where t.parent_id is null
		union select 'reservation', r.id, pt.tag_id from equipment_reservations r join project_tags pt on pt.project_id = r.project_id) s;
	select count(*) into tags_written from thread_tags;
	select count(*) into series_in from task_series where project_id is not null;
	select count(*) into series_written from task_series_tags;
	raise notice 'migration 0046: % record threads, % thread tags, % series tags', threads_written, tags_written, series_written;
	if records_in <> threads_written then raise exception 'migration 0046: % records but % record threads', records_in, threads_written; end if;
	if tags_in <> tags_written then raise exception 'migration 0046: % tag attachments in but % thread tags written', tags_in, tags_written; end if;
	if series_in <> series_written then raise exception 'migration 0046: % series projects in but % series tags written', series_in, series_written; end if;
end $$;

-- §8 step 5: task_tags, the three project_id columns with their constraints and indexes, and projects.
drop table task_tags;
-- 0032/0038's step check names project_id in its trigger's column list and body: replace it first. A task's place is
-- now fixed when it is created, because a top-level task has a thread and a step has none.
drop trigger tasks_check_parent on tasks;
create or replace function tasks_check_parent() returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare parent record;
begin
	if tg_op = 'UPDATE' and (old.parent_id is null) <> (new.parent_id is null) then
		raise exception 'a top-level task cannot become a step, nor a step a top-level task' using errcode = 'check_violation';
	end if;
	if new.parent_id is not null then
		if new.parent_id = new.id then raise exception 'a task cannot be its own parent' using errcode = 'check_violation'; end if;
		select parent_id into parent from public.tasks where organisation_id = new.organisation_id and id = new.parent_id;
		if not found then raise exception 'the parent task does not exist' using errcode = 'foreign_key_violation'; end if;
		if parent.parent_id is not null then raise exception 'a step cannot have steps of its own' using errcode = 'check_violation'; end if;
		if exists (select 1 from public.tasks where organisation_id = new.organisation_id and parent_id = new.id) then raise exception 'a task with steps cannot become a step' using errcode = 'check_violation'; end if;
	end if;
	return new;
end $$;
revoke all on function tasks_check_parent() from public;
create trigger tasks_check_parent before insert or update of parent_id on tasks for each row execute function tasks_check_parent();
alter table tasks drop column project_id;
create index tasks_by_status on tasks (organisation_id, status, due);
alter table task_series drop column project_id;
alter table equipment_reservations drop column project_id;
drop table projects;

-- The series routine's tenant discovery: a series produces occurrences unless it is paused. Tags never stop work.
create or replace function series_organisations() returns table (organisation_id uuid)
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
		select distinct s.organisation_id from public.task_series s where s.paused_at is null
	$$;
revoke all on function series_organisations() from public;
grant execute on function series_organisations() to app, captain_runtime;

-- Every update of a tag is a new revision (0039's function); a caller-supplied value is ignored.
create trigger tags_revision before update on tags for each row execute function work_revision_bump();

-- §4: the access predicate ------------------------------------------------------------------------------------------

-- True when the caller has an active membership in the thread's organisation (the current one) and the thread is a
-- record or topic thread, or a private thread in which the caller is an active participant. A record thread is
-- visible to whoever can see its record; every record policy is member-wide today, so that is active membership. A
-- migration that narrows a record's policy must amend this function in the same file. It takes no user argument, and
-- reads the participant rows as its owner, so the thread_participants policy can call it without recursion.
create function thread_visible(p_thread uuid) returns boolean
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
	select exists (
		select 1 from threads t
		join memberships m on m.organisation_id = t.organisation_id and m.user_id = current_user_id() and m.status = 'active'
		where t.id = p_thread and t.organisation_id = current_organisation_id()
			and (t.kind in ('record', 'topic') or exists (select 1 from thread_participants p
				where p.thread_id = t.id and p.user_id = m.user_id and p.state = 'active')))
$$;

-- The create bootstrap for topic and private threads (record threads come from their record's trigger). It inserts the
-- thread and, for a private thread, exactly one participant row, for the caller, and audits the creation. An existing
-- ID is 'matched' only for the same creator and kind, still able to see it, with the same fingerprint; anything else is
-- 'unavailable', without saying which. It never updates an existing thread.
create function thread_create(p_id uuid, p_kind text, p_title text, p_fingerprint bytea) returns text
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
		raise exception 'thread create needs a person in an organisation' using errcode = 'insufficient_privilege';
	end if;
	perform 1 from memberships where organisation_id = org and user_id = me and status = 'active' for share;
	if not found then
		raise exception 'thread create needs an active membership' using errcode = 'insufficient_privilege';
	end if;
	if p_kind is null or p_kind not in ('topic', 'private') then
		raise exception 'only a topic or private thread is created directly' using errcode = 'check_violation';
	end if;
	if clean is null or char_length(clean) not between 1 and 80 then
		raise exception 'a thread title has 1 to 80 characters' using errcode = 'check_violation';
	end if;
	if p_fingerprint is null or octet_length(p_fingerprint) <> 32 then
		raise exception 'a create fingerprint is 32 bytes' using errcode = 'check_violation';
	end if;
	begin
		insert into threads (id, organisation_id, kind, title, create_fingerprint, created_by)
			values (p_id, org, p_kind, clean, p_fingerprint, me)
			on conflict (id) do nothing
			returning threads.id into inserted;
	exception when unique_violation then
		get stacked diagnostics constraint_hit = constraint_name;
		if constraint_hit in ('threads_pkey', 'threads_organisation_id_id_key') then
			return 'unavailable';
		end if;
		raise;
	end;
	if inserted is not null then
		if p_kind = 'private' then
			insert into thread_participants (organisation_id, thread_id, user_id, state, added_by)
				values (org, p_id, me, 'active', me);
		end if;
		insert into chat_audit_events (organisation_id, thread_id, actor_id, action, subject_kind, subject_id, detail)
			values (org, p_id, me, 'chat.thread_created', 'thread', p_id,
				jsonb_build_object('threadId', p_id, 'kind', p_kind, 'revision', 1));
		return 'created';
	end if;
	select t.organisation_id, t.kind, t.created_by, t.create_fingerprint into existing from threads t where t.id = p_id;
	if found and existing.organisation_id = org and existing.kind = p_kind and existing.created_by = me and existing.create_fingerprint = p_fingerprint
		and (p_kind = 'topic' or exists (select 1 from thread_participants p where p.thread_id = p_id and p.user_id = me and p.state = 'active')) then
		return 'matched';
	end if;
	return 'unavailable';
end $$;

-- Ends a removed member's participation in every private thread, as chat_end_membership did (linked-chat §9.2).
create function thread_end_membership(p_target uuid) returns void
	language plpgsql volatile security definer set search_path = pg_catalog, public, pg_temp as $$
declare
	org uuid := current_organisation_id();
	me uuid := current_user_id();
	caller_status text;
	caller_role text;
	target_status text;
	thread record;
	new_revision integer;
begin
	if org is null or me is null or p_target is null then
		raise exception 'thread membership end refused' using errcode = 'insufficient_privilege';
	end if;
	if me = p_target then
		select m.status into target_status from memberships m where m.organisation_id = org and m.user_id = p_target for no key update;
	elsif me < p_target then
		select m.status, m.role into caller_status, caller_role from memberships m where m.organisation_id = org and m.user_id = me for share;
		select m.status into target_status from memberships m where m.organisation_id = org and m.user_id = p_target for no key update;
	else
		select m.status into target_status from memberships m where m.organisation_id = org and m.user_id = p_target for no key update;
		select m.status, m.role into caller_status, caller_role from memberships m where m.organisation_id = org and m.user_id = me for share;
	end if;
	if target_status is distinct from 'removed'
		or (me <> p_target and (caller_status is distinct from 'active' or caller_role is null or caller_role not in ('owner', 'admin'))) then
		raise exception 'thread membership end refused' using errcode = 'insufficient_privilege';
	end if;
	for thread in
		select t.id from threads t
		where t.organisation_id = org and t.kind = 'private' and exists (select 1 from thread_participants p
			where p.thread_id = t.id and p.user_id = p_target and p.state = 'active')
		order by t.id
		for update
	loop
		update thread_participants set state = 'removed', ended_at = now()
			where thread_id = thread.id and user_id = p_target and state = 'active';
		update threads set revision = revision + 1 where id = thread.id returning revision into new_revision;
		insert into chat_audit_events (organisation_id, thread_id, actor_id, action, subject_kind, subject_id, detail)
			values (org, thread.id, me, 'chat.participant_removed', 'participant', p_target,
				jsonb_build_object('threadId', thread.id, 'userId', p_target, 'revision', new_revision));
	end loop;
end $$;

-- Record threads (§3): inserted by the record's own insert, in the same transaction, so no service can forget one. A
-- step (a task with a parent) has none. Security invoker: the threads insert policy admits a record thread whose record
-- the inserting role can see.
create function thread_for_record() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
	if tg_table_name = 'tasks' then
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

-- Row-transition guards (linked-chat §9.4), security invoker, raising check_violation for anything not listed. Each
-- update check starts with Rule A: an update whose only changes null attribution columns of memberships that no longer
-- exist is allowed on any row and moves no counter. An insert naming a thread the caller cannot see is passed through so
-- row security refuses it with the same error whether or not the thread exists (no existence oracle).

create function thread_guard() returns trigger
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

create function thread_participants_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare
	me uuid := current_user_id();
	thread record;
	caller_participates boolean;
begin
	if tg_op = 'INSERT' then
		select t.created_by, t.last_seq, t.kind into thread from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id;
		if not found then
			return new; -- invisible or absent: row security (or the foreign key, for the owner) refuses it
		end if;
		if thread.kind <> 'private' then
			raise exception 'only a private thread has participants' using errcode = 'check_violation';
		end if;
		if me is null or new.state <> 'active' or new.ended_at is not null or new.added_by is distinct from me
			or not exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = new.user_id and m.status = 'active') then
			raise exception 'only an active member can be added, by the person adding them' using errcode = 'check_violation';
		end if;
		select exists (select 1 from thread_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
			where p.thread_id = new.thread_id and p.user_id = me and p.state = 'active' and m.status = 'active') into caller_participates;
		new.added_at := now();
		new.read_start_seq := thread.last_seq; -- the participation baseline, never the caller's
		if caller_participates then
			return new;
		end if;
		-- The bootstrap row: the creator adding themselves to a thread that has no participants yet.
		if new.user_id = me and thread.created_by = me
			and not exists (select 1 from thread_participants p where p.thread_id = new.thread_id) then
			return new;
		end if;
		raise exception 'only a participant can add people to a thread' using errcode = 'check_violation';
	end if;
	if (to_jsonb(new) - 'added_by') = (to_jsonb(old) - 'added_by')
		and (new.added_by is not distinct from old.added_by or (new.added_by is null
			and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.added_by))) then
		return new;
	end if;
	if new.organisation_id <> old.organisation_id or new.thread_id <> old.thread_id or new.user_id <> old.user_id then
		raise exception 'a participant row keeps its thread and person' using errcode = 'check_violation';
	end if;
	if old.state = 'active' and new.state = 'left' then
		if new.user_id = me and new.added_by is not distinct from old.added_by and new.added_at = old.added_at
			and new.read_start_seq = old.read_start_seq then
			new.ended_at := now();
			return new;
		end if;
	elsif old.state = 'active' and new.state = 'removed' then
		if new.added_by is not distinct from old.added_by and new.added_at = old.added_at and new.read_start_seq = old.read_start_seq and (
			(new.user_id <> me
				and exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = me
					and m.status = 'active' and m.role in ('owner', 'admin'))
				and exists (select 1 from thread_participants p where p.thread_id = new.thread_id and p.user_id = me and p.state = 'active'))
			or (exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = new.user_id and m.status = 'removed'))) then
			new.ended_at := now();
			return new;
		end if;
	elsif old.state in ('left', 'removed') and new.state = 'active' then
		if new.user_id <> me and new.added_by = me
			and exists (select 1 from memberships m where m.organisation_id = new.organisation_id and m.user_id = new.user_id and m.status = 'active')
			and exists (select 1 from thread_participants p join memberships m on m.organisation_id = p.organisation_id and m.user_id = p.user_id
				where p.thread_id = new.thread_id and p.user_id = me and p.state = 'active' and m.status = 'active') then
			select t.last_seq into thread from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id;
			new.added_at := now();
			new.ended_at := null;
			new.read_start_seq := thread.last_seq;
			return new;
		end if;
	end if;
	raise exception 'that participant change is not allowed' using errcode = 'check_violation';
end $$;

create function thread_tags_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare me uuid := current_user_id(); thread_kind text;
begin
	if tg_op = 'INSERT' then
		select t.kind into thread_kind from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id;
		if not found then
			return new; -- invisible or absent: row security refuses it
		end if;
		if new.attached_by is distinct from me then
			raise exception 'a tag is attached by the person attaching it' using errcode = 'check_violation';
		end if;
		-- With no person (the series routine), only a record thread; otherwise someone who can see the thread.
		if (me is null and thread_kind <> 'record') or (me is not null and not thread_visible(new.thread_id)) then
			raise exception 'only someone who can see the thread tags it' using errcode = 'check_violation';
		end if;
		new.attached_at := now();
		return new;
	end if;
	if (to_jsonb(new) - 'attached_by') = (to_jsonb(old) - 'attached_by') and new.attached_by is null and old.attached_by is not null
		and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.attached_by) then
		return new;
	end if;
	raise exception 'a thread tag is attached or removed, never changed' using errcode = 'check_violation';
end $$;

create function thread_messages_guard() returns trigger
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
		-- R2 writes plain messages only; R3 and R5 replace this guard when they write change lines and approval cards.
		if new.kind <> 'message' then
			raise exception 'only a message can be sent' using errcode = 'check_violation';
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
	if old.deleted_at is not null then
		raise exception 'a deleted message cannot be changed' using errcode = 'check_violation';
	end if;
	if new.id <> old.id or new.organisation_id <> old.organisation_id or new.thread_id <> old.thread_id or new.kind <> old.kind
		or new.seq <> old.seq or new.created_at <> old.created_at or new.author_id is distinct from old.author_id then
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

create function thread_pins_guard() returns trigger
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
		-- A pin is shown to everyone who sees the thread, so only an owner or admin sets one (§1, §4).
		if not moderator then
			raise exception 'only an owner or admin pins a message' using errcode = 'check_violation';
		end if;
		select m.thread_id, m.deleted_at into target from thread_messages m where m.organisation_id = new.organisation_id and m.id = new.message_id;
		if not found or target.thread_id <> new.thread_id then
			raise exception 'a pin names a message in its own thread' using errcode = 'check_violation';
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
	-- Live to unpinned: an owner or admin, or anyone whose deletion of the pinned message unpins it in the same
	-- transaction (the message is already a tombstone), as themselves, with a fresh change number no message holds.
	if thread_visible(new.thread_id) and new.unpinned_at is not null and new.unpinned_by = me
		and (moderator or exists (select 1 from thread_messages m where m.id = old.message_id and m.deleted_at is not null))
		and new.change_seq = counters.last_change and new.change_seq > old.change_seq
		and not exists (select 1 from thread_messages m where m.thread_id = new.thread_id and m.change_seq = new.change_seq) then
		new.unpinned_at := now();
		return new;
	end if;
	raise exception 'that pin change is not allowed' using errcode = 'check_violation';
end $$;

create function thread_stars_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
	if tg_op = 'INSERT' then
		if not exists (select 1 from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id) then
			return new;
		end if;
		if current_user_id() is null or new.user_id is distinct from current_user_id() then
			raise exception 'a star is set by its own person' using errcode = 'check_violation';
		end if;
		new.created_at := now();
		return new;
	end if;
	raise exception 'a star is set or cleared, never changed' using errcode = 'check_violation';
end $$;

create function thread_reads_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare latest integer;
begin
	select t.last_seq into latest from threads t where t.id = new.thread_id and t.organisation_id = new.organisation_id;
	if tg_op = 'INSERT' then
		if latest is null then
			return new;
		end if;
		if current_user_id() is null or new.user_id is distinct from current_user_id() then
			raise exception 'a read position is written by its own person' using errcode = 'check_violation';
		end if;
		if new.last_read_seq < 0 or new.last_read_seq > latest then
			raise exception 'a read position is between 0 and the latest message' using errcode = 'check_violation';
		end if;
		new.updated_at := now();
		return new;
	end if;
	if new.organisation_id <> old.organisation_id or new.thread_id <> old.thread_id or new.user_id <> old.user_id
		or current_user_id() is distinct from old.user_id then
		raise exception 'a read position belongs to one person in one thread' using errcode = 'check_violation';
	end if;
	if latest is null or new.last_read_seq <= old.last_read_seq or new.last_read_seq > latest then
		raise exception 'a read position only advances, up to the latest message' using errcode = 'check_violation';
	end if;
	new.updated_at := now();
	return new;
end $$;

create function thread_audit_guard() returns trigger
	language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
	if tg_op = 'INSERT' then
		if current_user_id() is null or new.actor_id is distinct from current_user_id() then
			raise exception 'chat audit records the person acting' using errcode = 'check_violation';
		end if;
		new.created_at := now();
		return new;
	end if;
	if (to_jsonb(new) - 'actor_id') = (to_jsonb(old) - 'actor_id') and new.actor_id is null and old.actor_id is not null
		and not exists (select 1 from memberships m where m.organisation_id = old.organisation_id and m.user_id = old.actor_id) then
		return new;
	end if;
	raise exception 'chat audit is append-only' using errcode = 'check_violation';
end $$;

-- Every seq has its message (linked-chat §9.5): the one non-callable definer trigger, read-only.
create function thread_seq_check() returns trigger
	language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
	if not exists (select 1 from threads t where t.id = new.id) then
		return null;
	end if;
	if not exists (select 1 from thread_messages m where m.thread_id = new.id and m.seq = new.last_seq) then
		raise exception 'every message number needs its message: a send advanced the counter without one' using errcode = 'check_violation';
	end if;
	return null;
end $$;

create trigger threads_guard before insert or update on threads for each row execute function thread_guard();
create constraint trigger threads_seq_has_message after update on threads
	deferrable initially deferred for each row
	when (new.last_seq is distinct from old.last_seq)
	execute function thread_seq_check();
create trigger thread_participants_guard before insert or update on thread_participants for each row execute function thread_participants_guard();
create trigger thread_tags_guard before insert or update on thread_tags for each row execute function thread_tags_guard();
create trigger thread_messages_guard before insert or update on thread_messages for each row execute function thread_messages_guard();
create trigger thread_pins_guard before insert or update on thread_pins for each row execute function thread_pins_guard();
create trigger thread_stars_guard before insert or update on thread_stars for each row execute function thread_stars_guard();
create trigger thread_reads_guard before insert or update on thread_reads for each row execute function thread_reads_guard();
create trigger chat_audit_events_guard before insert or update on chat_audit_events for each row execute function thread_audit_guard();
create trigger tasks_thread after insert on tasks for each row when (new.parent_id is null) execute function thread_for_record();
create trigger equipment_reservations_thread after insert on equipment_reservations for each row execute function thread_for_record();
create trigger stock_items_thread after insert on stock_items for each row execute function thread_for_record();

-- Row security (all `to app, captain_runtime`) --------------------------------------------------------------------
-- V(x) is thread_visible(x). With no person in the transaction (a system routine such as the series materialiser),
-- record threads and their tags are readable and taggable, never their messages, participants, pins or audit.

alter table threads enable row level security;
alter table threads force row level security;
create policy threads_select on threads for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and (thread_visible(id) or (current_user_id() is null and kind = 'record')));
-- Only record threads are inserted directly (by the record's trigger), for a record the inserting role can see;
-- topic and private threads come only from thread_create.
create policy threads_insert on threads for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and kind = 'record' and created_by is not distinct from current_user_id()
		and (current_user_id() is null or exists (select 1 from memberships m where m.organisation_id = threads.organisation_id
			and m.user_id = current_user_id() and m.status = 'active'))
		and (exists (select 1 from tasks t where t.organisation_id = threads.organisation_id and t.id = threads.task_id and t.parent_id is null)
			or exists (select 1 from equipment_reservations r where r.organisation_id = threads.organisation_id and r.id = threads.reservation_id)
			or exists (select 1 from stock_items s where s.organisation_id = threads.organisation_id and s.id = threads.stock_item_id)));
create policy threads_update on threads for update to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(id))
	with check (organisation_id = current_organisation_id());

alter table thread_participants enable row level security;
alter table thread_participants force row level security;
create policy thread_participants_select on thread_participants for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id));
create policy thread_participants_insert on thread_participants for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and thread_visible(thread_id) and added_by = current_user_id());
create policy thread_participants_update on thread_participants for update to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id))
	with check (organisation_id = current_organisation_id());

alter table thread_tags enable row level security;
alter table thread_tags force row level security;
create policy thread_tags_select on thread_tags for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and (thread_visible(thread_id)
		or (current_user_id() is null and exists (select 1 from threads t where t.id = thread_tags.thread_id and t.kind = 'record'))));
create policy thread_tags_insert on thread_tags for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and attached_by is not distinct from current_user_id() and (thread_visible(thread_id)
		or (current_user_id() is null and exists (select 1 from threads t where t.id = thread_tags.thread_id and t.kind = 'record'))));
create policy thread_tags_delete on thread_tags for delete to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id));

-- A series' tags are work data like the series itself (0002's task_series policy): tenant-wide, for the routine too.
alter table task_series_tags enable row level security;
alter table task_series_tags force row level security;
create policy task_series_tags_tenant on task_series_tags for all to app, captain_runtime
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());

alter table thread_messages enable row level security;
alter table thread_messages force row level security;
create policy thread_messages_select on thread_messages for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id));
create policy thread_messages_insert on thread_messages for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and thread_visible(thread_id) and author_id = current_user_id());
create policy thread_messages_update on thread_messages for update to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id))
	with check (organisation_id = current_organisation_id());

alter table thread_pins enable row level security;
alter table thread_pins force row level security;
create policy thread_pins_select on thread_pins for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id));
create policy thread_pins_insert on thread_pins for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and thread_visible(thread_id) and pinned_by = current_user_id());
create policy thread_pins_update on thread_pins for update to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id))
	with check (organisation_id = current_organisation_id());

-- Personal rows: visible only to their own person, and only while that person can see the thread.
alter table thread_stars enable row level security;
alter table thread_stars force row level security;
create policy thread_stars_select on thread_stars for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id) and user_id = current_user_id());
create policy thread_stars_insert on thread_stars for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and thread_visible(thread_id) and user_id = current_user_id());
create policy thread_stars_delete on thread_stars for delete to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id) and user_id = current_user_id());

alter table thread_reads enable row level security;
alter table thread_reads force row level security;
create policy thread_reads_select on thread_reads for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id) and user_id = current_user_id());
create policy thread_reads_insert on thread_reads for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and thread_visible(thread_id) and user_id = current_user_id());
create policy thread_reads_update on thread_reads for update to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id) and user_id = current_user_id())
	with check (organisation_id = current_organisation_id() and user_id = current_user_id());

alter table chat_audit_events enable row level security;
alter table chat_audit_events force row level security;
create policy chat_audit_events_select on chat_audit_events for select to app, captain_runtime
	using (organisation_id = current_organisation_id() and thread_visible(thread_id) and (not personal or actor_id = current_user_id()));
create policy chat_audit_events_insert on chat_audit_events for insert to app, captain_runtime
	with check (organisation_id = current_organisation_id() and thread_visible(thread_id) and actor_id = current_user_id());

-- Grants: nothing is deleted but stars and thread tags (tag removal is a delete); threads are inserted only as record
-- threads; audit is append-only.
grant select, insert, update on threads to app, captain_runtime;
grant select, insert, update on thread_participants to app, captain_runtime;
grant select, insert, delete on thread_tags to app, captain_runtime;
grant select, insert, delete on task_series_tags to app, captain_runtime;
grant select, insert, update on thread_messages to app, captain_runtime;
grant select, insert, update on thread_pins to app, captain_runtime;
grant select, insert, delete on thread_stars to app, captain_runtime;
grant select, insert, update on thread_reads to app, captain_runtime;
grant select, insert on chat_audit_events to app, captain_runtime;

revoke all on function thread_visible(uuid), thread_create(uuid, text, text, bytea), thread_end_membership(uuid), thread_for_record(),
	thread_guard(), thread_participants_guard(), thread_tags_guard(), thread_messages_guard(), thread_pins_guard(),
	thread_stars_guard(), thread_reads_guard(), thread_audit_guard(), thread_seq_check() from public;
grant execute on function thread_visible(uuid), thread_create(uuid, text, text, bytea), thread_end_membership(uuid) to app, captain_runtime;
