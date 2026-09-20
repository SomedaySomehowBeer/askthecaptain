-- Weighted drafting (plan §6, Phase 5): every draft records how it ended, and a person can hold one for later.
alter table outbox add column outcome text check (outcome in ('sent', 'edited_sent', 'discarded', 'not_needed', 'expired'));
alter table outbox add column edited boolean not null default false;
alter table outbox add column remind_at timestamptz;
update outbox set outcome = 'sent' where state = 'sent' and outcome is null;
update outbox set outcome = 'discarded' where state = 'discarded' and outcome is null;
alter table outbox add constraint outbox_outcome_closed check ((state = 'drafted') = (outcome is null));
alter table outbox add constraint outbox_outcome_matches_state check (
	(state = 'sent' and outcome in ('sent', 'edited_sent')) or (state = 'discarded' and outcome in ('discarded', 'not_needed', 'expired')) or state = 'drafted');
