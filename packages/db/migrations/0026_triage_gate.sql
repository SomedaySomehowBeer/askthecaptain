-- D20: the triage gate. Mail sync keeps four list/automation headers; sender priors learn from verdicts,
-- replies, stars and draft outcomes so bulk and automated mail is filed without a model call.
alter table mail_messages
	add column list_unsubscribe boolean not null default false,
	add column list_id text not null default '',
	add column precedence text not null default '',
	add column auto_submitted text not null default '';
create table mail_senders (
	organisation_id uuid not null references organisations(id) on delete cascade,
	email text not null check (email = lower(email)),
	threads_seen integer not null default 0,
	information_verdicts integer not null default 0,
	needs_owner_count integer not null default 0,
	replies integer not null default 0,
	stars integer not null default 0,
	drafts_sent integer not null default 0,
	drafts_edited integer not null default 0,
	drafts_discarded integer not null default 0,
	drafts_not_needed integer not null default 0,
	drafts_requested integer not null default 0,
	last_seen_at timestamptz not null default now(),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (organisation_id, email)
);
alter table mail_senders enable row level security;
alter table mail_senders force row level security;
create policy mail_senders_tenant on mail_senders for all to app
	using (organisation_id = current_organisation_id()) with check (organisation_id = current_organisation_id());
grant select, insert, update, delete on mail_senders to app;
