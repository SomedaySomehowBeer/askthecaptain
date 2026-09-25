-- #131 / #133 step 5: integer revisions for tasks, projects and series, so a Work page can save with
-- a precondition that survives wire precision and concurrent writers. The database increments the
-- revision on every UPDATE of a row, whoever writes it: a person's PATCH, a checklist or status
-- cascade, a project move, evidence changes that touch their task, or a workflow. A writer cannot
-- set or skip it. Inserts start at 1. No table is added; the only data change is the evidence_required
-- backfill below.
alter table tasks add column revision integer not null default 1 check (revision > 0);
alter table projects add column revision integer not null default 1 check (revision > 0);
alter table task_series add column revision integer not null default 1 check (revision > 0);

-- Whether a task needs evidence before it counts as done belongs to the task. An occurrence copies its
-- series' rule when it is created, so editing the series changes future occurrences only (as the series
-- contract already says) and completion reads only the locked task row, not a series that may be changing.
-- Backfilled before the revision trigger exists, so existing rows keep their revision.
alter table tasks add column evidence_required boolean not null default false;
update tasks t set evidence_required = s.evidence_required from task_series s
	where s.organisation_id = t.organisation_id and s.id = t.series_id and s.evidence_required;

-- Every update is a new revision, including an explicit "touch" (`set updated_at = now()`), which is
-- how a parent records that its checklist or evidence changed. A caller-supplied value is ignored.
create function work_revision_bump() returns trigger language plpgsql as $$
begin
	new.revision := old.revision + 1;
	return new;
end $$;
revoke all on function work_revision_bump() from public;
create trigger tasks_revision before update on tasks for each row execute function work_revision_bump();
create trigger projects_revision before update on projects for each row execute function work_revision_bump();
create trigger task_series_revision before update on task_series for each row execute function work_revision_bump();

-- Bounded Work reads: a task's checklist and a series' occurrences are listed per tenant in a stable order.
create index tasks_checklist on tasks (organisation_id, parent_id, created_at, id) where parent_id is not null;
create index tasks_by_series on tasks (organisation_id, series_id, period_start desc, id) where series_id is not null;
create index evidence_by_task on evidence (organisation_id, task_id, attached_at, id);
