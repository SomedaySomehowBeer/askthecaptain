# DRAFT — Privacy notice

**16 September 2026 — for the owner's review; not yet in force.**

## Who this is about

Captain helps a small business manage mail, correspondence, calendars, commitments, chasing and
briefs, and answer questions from saved business data. This notice describes information about people
using Captain and people appearing in a business's connected records, such as customers and suppliers.
“We” means Captain's service operator; “organisation owner” means the person managing a business's
Captain organisation. **TODO owner [P1]: insert the operator's legal name, business address, privacy
contact address and effective date. Contact address: TODO owner.**
<!-- Sources: docs/plan.md §§1–2, 5, 9. Operator identity and publication details require owner decision. -->

## What we collect and why

We use information entered by members and copied from accounts connected by the business to provide
these administrative jobs. Per organisation, Captain keeps:

- Organisation settings, memberships, invitations, connection status and sync records.
- Gmail threads, message bodies, snippets, sender/recipient and other saved headers, provider IDs,
  labels, triage summaries and extracted facts; outbox drafts and send/discard records.
- Attachment metadata: names, types, sizes and provider references. Attachment bytes are fetched
  temporarily for allowed extraction, never stored as files by Captain. Currently plain text and
  CSV up to 5 MB can be extracted, capped at 20,000 characters; PDFs are skipped.
- Calendar events, descriptions, locations, organisers, attendees and local preparation notes;
  contacts and companies, including contact details and notes.
- Projects, tasks, recurring duties, owners, dates and evidence links; stock items, counts,
  count history, locations, suppliers and reorder points.
- Notes you or your team write in Captain, with whatever event, contact, company, project or
  task you attached them to. <!-- plan §5 Notes, D23; not yet built -->
- Xero contacts, invoices, bills and payments; Shopify products, variants, quantities by location,
  reorder points and accessible orders, including customer name/email where supplied.
- Workflow settings and journals, audit records of who changed what, inference runtime details,
  token allowances and usage, saved briefs, and questions with answers, confidence and sources.
- Push device endpoints and keys, device descriptions and delivery records, including notification
  title, body, destination and outcome.
<!-- Sources: docs/plan.md §5; packages/db/src/mail-schema.ts, triage-schema.ts, calendar-schema.ts,
contacts-schema.ts, stock-schema.ts, xero-schema.ts, shopify-schema.ts, workflows-schema.ts,
inference-schema.ts, briefs-schema.ts, answers-schema.ts; apps/api/src/triage/service.ts;
apps/api/src/push/service.ts. -->

Separately, Captain keeps a person's name, email, Google sign-in identity, session records,
sign-in outcomes and registered passkey public credentials. Captain does not collect your provider
passwords. Connected-account access and refresh tokens are stored encrypted using an organisation
data key, itself wrapped by a master key held in the API's secrets. Sprite connection secrets use the
same protection. Subscription login credentials stay on that organisation's Sprite, outside prompts.
This does not mean all business records are individually encrypted with that key.
<!-- Sources: packages/db/migrations/0001_foundation.sql; apps/api/src/auth/passkeys.ts;
docs/plan.md §§7, 9, D16, D18; docs/runbooks/inference-sprite.md, Owner/operator setup. -->

## Who processes information

| Service | Role in Captain |
|---|---|
| Fly.io | API and web hosting configured in Sydney; a separate Captain-run Fly Sprite for each organisation's inference. |
| Neon | Postgres database, configured in the Sydney region. |
| Cloudflare | DNS. Current application records are DNS-only, not proxied through Cloudflare. |
| Tigris and GitHub Actions | Backup storage; scheduled database dumps and temporary restore rehearsals, respectively. GitHub Actions also builds and deploys Captain. |
| Google, Xero and Shopify | The business's own connected providers, supplying records and receiving authorised operations such as person-sent mail. Google also provides sign-in. |
| Anthropic or OpenAI | Inference through the organisation's own Claude or Codex subscription, using its CLI on the Captain-run Sprite. |
| Device/browser vendor push services | Delivery of encrypted notifications to subscribed devices. |
| Better Stack | API health monitoring used for operational support. |
<!-- Sources: docs/plan.md §§4, 7–9, D12, D18; apps/api/fly.staging.toml;
apps/web/fly.staging.toml; infra/tofu/neon.tf, dns.tf, uptime.tf;
.github/workflows/backup.yml; docs/runbooks/support.md; apps/api/src/push/webpush.ts. -->

**TODO owner [P2]: confirm the current provider list, contracts, processing countries and overseas
disclosures, including backup locations, actual Sprite region, inference-provider retention/training
settings and push services.** Sydney app hosting is not a promise that all processing stays in
Australia. Sprite region must be checked separately. No provider-wide retention or training promise
is made by this draft.
<!-- Sources: docs/runbooks/inference-sprite.md, Product surface checked; infra/tofu/main.tf;
provider terms/settings and actual processing locations require owner verification. -->

## What the model receives

Mail bodies reach inference only in triage and reply-drafting steps of enabled workflows. Allowed
attachment text is supplied to triage; drafting also uses triage results. Other infer steps receive
bounded business data for briefs, invoice chasers and meeting preparation. Today's question box sends
one question and deterministically selected records, including mail subjects/snippets from the last
60 days, without mail bodies or attachment text. Previous questions are not conversation context.
<!-- Sources: docs/plan.md §§6–7, 10; apps/api/src/triage/service.ts;
apps/api/src/briefs/service.ts; apps/api/src/chase/service.ts;
apps/api/src/answers/retrieve.ts, service.ts; apps/api/src/calendar-prep/service.ts. -->

Inputs are labelled untrusted. Models receive no tools or credentials and cannot themselves write or
send. Outputs are schema-validated. Usage records contain counts, model, timing and step information,
not prompt content; prompts and provider output must not be written to diagnostic logs. Business
records are still saved: workflow step outputs can include mail content and generated results, and
briefs, drafts and answers persist. Extracted attachment text is excluded from the workflow journal.
<!-- Sources: docs/plan.md §§3, 5, 7, D2; docs/runbooks/inference-sprite.md, Data-only invocation;
packages/db/src/workflows-schema.ts; apps/api/src/triage/service.ts; packages/engine/src/pg-boss.ts. -->

## Access and security

Members use their organisation's shared business data. Owners and admins manage access, connections
and workflows; only owners delete an organisation or configure its inference runtime. Owners/admins
can export all organisation exchanges, although question history shows the asking person's exchanges.
Support must not read mail bodies unless asked to inspect a specific thread, and must never read or
hand over provider tokens, Sprite secrets or the master key.
<!-- Sources: docs/plan.md §9; apps/api/src/organisations/service.ts, lifecycle.ts;
apps/api/src/inference/service.ts; apps/api/src/answers/service.ts; docs/runbooks/support.md. -->

Captain uses forced database row security to separate organisations, encrypted connection secrets,
HTTPS, request rate limits, audit records and Google sign-in. Once you register a passkey it is
required at subsequent sign-ins. These measures do not establish an absolute security guarantee.
<!-- Sources: docs/plan.md §9; apps/api/src/auth/passkeys.ts; apps/api/src/ratelimit.ts;
infra/tofu/neon.tf; apps/api/fly.staging.toml. -->

## Retention, export and deletion

Attachment text becomes inaccessible after at most 24 hours; hourly housekeeping physically deletes
expired rows. Nightly whole-database backups can contain that text and other business records. The
backup job prunes dumps older than 30 days; Neon restore history is separately configured for six
hours. These are configured processes, not evidence that every scheduled run succeeded.
<!-- Sources: apps/api/src/triage/expiry.ts; packages/db/src/triage-schema.ts;
.github/workflows/backup.yml; infra/tofu/neon.tf; docs/runbooks/backup-and-restore.md. -->

An owner/admin can use Settings → Your data → Download everything at any time while authorised and
the service is available. The export includes tenant tables without credentials. For private saved
Work views it includes only the exporting person's own live views, not other members' views or
content-free deletion tombstones; it is not a complete backup of personal views. Removing a member
keeps their views stored but inaccessible until that membership is reactivated. Deleting the
membership or organisation removes its saved views by cascade. The owner can delete
the organisation there by typing its name. This removes its live tenant records, including journals
and audit records, and retains one platform deletion record: organisation ID/name, deleting person's
ID/email, time and row counts (excluding private saved views). Provider revocation is attempted, not guaranteed. Existing provider
records and delivered messages remain outside Captain; Sprite removal and login revocation require
operator action. Platform identities, sign-in records and existing backups are not erased by that
organisation deletion.
<!-- Sources: apps/api/src/organisations/lifecycle.ts; apps/api/src/index.ts;
packages/db/migrations/0001_foundation.sql, 0015_organisation_deletions.sql;
docs/runbooks/inference-sprite.md, Allowances, failures and operation. -->

**TODO owner [P3]: approve retention periods for other business records, platform identities/security
records, deletion records and diagnostics; confirm backup expiry monitoring, post-restore deletion
handling and timely Sprite cleanup.** This draft promises no automatic expiry for those other records.
<!-- Sources: docs/plan.md §§5, 9; docs/runbooks/backup-and-restore.md; retention decisions remain open. -->

## Your requests and applicable law

For business-data access or correction, contact your organisation owner/admin; they can export and
manage records. For personal-information requests, deletion or privacy complaints, contact
**TODO owner [P1]: privacy contact address**. Organisation deletion is available as described above;
there is no equivalent promise of self-service individual account erasure.
<!-- Sources: docs/runbooks/support.md; apps/api/src/organisations/lifecycle.ts. -->

**TODO owner/lawyer [P4]: which jurisdiction applies? Are the Australian Privacy Principles the
appropriate frame for this WA business, and does the Privacy Act cover this operator?** Confirm access,
correction and complaint rights, identity checks, response process, timeframes and external escalation
before publication. Coverage is a question, not a compliance claim. Review the
[OAIC small-business guidance](https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business)
and [APP overview](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-quick-reference).
<!-- Sources: docs/plan.md §9; OAIC links checked 2026-09-16. Legal applicability and process require review. -->
