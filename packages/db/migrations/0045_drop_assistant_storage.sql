-- R5b (docs/plans/assistant-code-removal-2026-09.md): drop the retired assistant's storage.
--
-- Preconditions, recorded outside this file: R5a's reader-free API is the deployed staging image and the rollback
-- baseline (docs/validation/assistant-retirement-release-2026-09-27/README.md), and a read-only owner audit at
-- 2026-09-27T06:13:25Z found every table below empty, the three retained columns null, the seven functions present,
-- and only the expected contacts foreign key into them. This migration repeats the emptiness check inside its own
-- transaction, after locking, so a row that appeared since stops it and nothing is dropped or deleted.
--
-- No CASCADE anywhere: an unknown dependency fails the migration loudly instead of silently taking something with it.
-- Retained on purpose: the vector extension, projects' proposal/brief columns and generated state, the evidence,
-- tasks and contacts provenance values, auth_requests kinds, and connections/sync_cursors (Xero and Shopify).
-- Rollback is a forward fix or an image at or after R5a. Never recreate these tables.

-- Hold every table this touches, so nothing can be written between the check and the drop. The release runs this with
-- HTTP stopped, so nothing should hold these locks; if an unexpected session does, fail within 30 seconds rather than
-- wait indefinitely while queuing every later reader of contacts and workflow_enablements behind this migration.
set local lock_timeout = '30s';
lock table
	note_triage, notes, content_vectors, project_candidate_sources, project_candidates, project_sources, discovery_seeds,
	mail_triage, sent_triage, attachment_text, mail_attachments, outbox, mail_messages, mail_senders, mail_threads,
	calendar_events, calendars, briefs, answers, webhook_attempts, webhook_events
	in access exclusive mode;
lock table contacts, workflow_enablements in share row exclusive mode;

-- 1. Guard. Row security is off for the check, so a count is either exact or an error, never a filtered zero.
set local row_security = off;
do $$
declare
	legacy constant text[] := array[
		'note_triage', 'notes', 'content_vectors', 'project_candidate_sources', 'project_candidates', 'project_sources',
		'discovery_seeds', 'mail_triage', 'sent_triage', 'attachment_text', 'mail_attachments', 'outbox', 'mail_messages',
		'mail_senders', 'mail_threads', 'calendar_events', 'calendars', 'briefs', 'answers', 'webhook_attempts', 'webhook_events'];
	legacy_name text;
	has_rows boolean;
begin
	foreach legacy_name in array legacy loop
		execute format('select exists (select 1 from public.%I)', legacy_name) into has_rows;
		if has_rows then raise exception 'migration 0045 refused: % has rows; nothing was dropped', legacy_name; end if;
	end loop;
	if exists (select 1 from public.contacts where last_thread_id is not null) then
		raise exception 'migration 0045 refused: contacts.last_thread_id is set; nothing was dropped';
	end if;
	if exists (select 1 from public.workflow_enablements where mail_cursor is not null or sent_cursor is not null) then
		raise exception 'migration 0045 refused: workflow_enablements.mail_cursor or sent_cursor is set; nothing was dropped';
	end if;
end $$;
set local row_security = on;

-- 2. Retained tables' columns tied to the legacy storage (the first removes 0006's foreign key into mail_threads).
alter table contacts drop column last_thread_id;
alter table workflow_enablements drop column mail_cursor, drop column sent_cursor;

-- 3. Tables, children first. Their indexes, policies, grants and triggers go with them.
drop table note_triage;
drop table notes;
drop table content_vectors;
drop table project_candidate_sources;
drop table project_candidates;
drop table project_sources;
drop table discovery_seeds;
drop table mail_triage;
drop table sent_triage;
drop table attachment_text;
drop table mail_attachments;
drop table outbox;
drop table mail_messages;
drop table mail_senders;
drop table mail_threads;
drop table calendar_events;
drop table calendars;
drop table briefs;
drop table answers;
drop table webhook_attempts;
drop table webhook_events;

-- 4. The legacy security-definer and trigger functions. Their triggers were on the tables dropped above.
drop function gmail_sync_organisations();
drop function calendar_sync_organisations();
drop function attachment_text_organisations();
drop function index_organisations();
drop function content_vectors_cascade();
drop function project_sources_cascade();
drop function clear_changed_event_note();
