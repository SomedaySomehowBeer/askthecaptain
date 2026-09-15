-- The materialise-series system routine (plan §5 task_series, §6 "system routines"): the API creates
-- the next occurrence of every active series at the start of its period. This is the narrow
-- discovery the scheduler needs: which organisations have a series that can produce an occurrence.
-- It returns tenant ids only; all the work then happens under withTenant as the runtime role.
create function series_organisations() returns table (organisation_id uuid)
	language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
		select distinct s.organisation_id from public.task_series s join public.projects p on p.id = s.project_id
		where s.paused_at is null and p.archived_at is null
	$$;
revoke all on function series_organisations() from public;
grant execute on function series_organisations() to app;
