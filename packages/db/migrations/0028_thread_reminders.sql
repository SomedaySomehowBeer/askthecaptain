-- A needs-you thread without a draft can be held for later (plan §6: Remind me later beside Draft a reply).
alter table mail_triage add column remind_at timestamptz;
