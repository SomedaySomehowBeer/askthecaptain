-- Keep invoice identity on a draft across workflow runs and invoice-cache replacement.
alter table outbox add column invoice_provider_id text;
create index outbox_invoice_history on outbox (organisation_id, invoice_provider_id, state, sent_at)
 where invoice_provider_id is not null;

-- Existing chase runs already journal the source invoice and destination draft. Preserve their
-- pending drafts and send history too; do not guess from an editable subject or recipient.
update outbox o set invoice_provider_id = i.provider_id
from workflow_run_steps written
join workflow_runs run on run.organisation_id = written.organisation_id and run.id = written.run_id
join workflow_run_steps source on source.organisation_id = run.organisation_id and source.run_id = run.id
 and source.key = 'xero.overdueReceivables'
join xero_invoices i on i.organisation_id = run.organisation_id
 and i.id::text = source.output #>> array['invoices', written.item_index::text, 'id']
where run.definition_key = 'chase-due' and written.key = 'outbox.create'
 and o.organisation_id = written.organisation_id and o.id::text = written.output->>'id';
