# Contacts and companies

Shared people/company records remain available through Resources → People and companies, with
contact detail at `/settings/contacts/:id`. Old `/inbox/contacts/:id` links redirect to the same
record. No mail, calendar, model or background harvesting is required.

All active members may read and edit `/contacts` and `/companies` under their organisation. Search
accepts `q` and `limit` (1–200), returning `hasMore`. Email/domain conflicts return 409. Records
archive through `PATCH {"archived":true}` and restore through `PATCH {"archived":false}`. Restore
an archived contact before editing; an existing archived company association may be retained.
Tenant RLS, composite references and audited writes remain.

Contact detail returns the contact/company information, with no recent-thread or Notes panel.
The old mail-derived harvesting implementation is removed. Historic source IDs and records remain
stored for the later inspected storage cleanup; their existence does not establish useful live data.
See the [retirement contract](../plans/assistant-runtime-retirement-2026-09.md) and [plan](../plan.md).
