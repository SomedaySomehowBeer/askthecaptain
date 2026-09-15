-- Issue #38: model_usage.run_id was left a bare uuid in 0007 because workflow_runs did not exist yet.
-- A usage row now points at its run with the tenant carried in the key (a foreign-key check bypasses
-- row security), and a deleted run leaves the usage row with no run rather than deleting it.
alter table model_usage add constraint model_usage_run_fk
	foreign key (organisation_id, run_id) references workflow_runs(organisation_id, id) on delete set null (run_id);
create index model_usage_run on model_usage (organisation_id, run_id) where run_id is not null;
