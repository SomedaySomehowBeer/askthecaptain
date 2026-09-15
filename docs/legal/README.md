# Legal drafts for owner review

**DRAFT — 16 September 2026 — for the owner's review; not yet in force.**

- [Privacy notice](privacy-notice.md)
- [Terms of service](terms-of-service.md)

These are review documents, not published policies or accepted customer terms. No application pages
or enforcement behaviour are changed. HTML comments identify repository evidence; proposed promises
and legal decisions are marked as TODOs. “Owner” in a TODO means the repository/service owner;
“organisation owner” in the drafts means the customer's administrator with the owner role.

This supports job 6, **Brief and answer**, and the other five administrative jobs becoming ready for a
second business. Plan §9 requires a privacy notice and terms before the second tenant; §11 Phase 4
includes them. Drafts alone do not satisfy that publication and review prerequisite.
<!-- Sources: docs/plan.md §§2, 9, 11; AGENTS.md, How work moves. -->

## Decisions to complete

The identifiers below gather every TODO from the drafts. The owner should resolve them with a lawyer
where indicated, update both documents consistently and approve final publication separately.

| ID | Decision |
|---|---|
| P1 | Operator legal identity/address, privacy contact address (`TODO owner`), effective date. |
| P2 | Verify provider inventory/contracts, processing countries and overseas disclosures, Tigris backup location, actual Sprite region, inference retention/training settings and device push providers. |
| P3 | Approve business-data, platform account/security, deletion-record and diagnostic retention; verify backup expiry monitoring, handling of deleted data after restore and timely Sprite/login cleanup. |
| P4 | Lawyer: jurisdiction and whether Australian Privacy Principles/Privacy Act apply to this WA operator; confirm individual access, correction, deletion and complaint processes, identity checks, timeframes and external escalation. |
| T1 | Contracting operator/customer, authority to accept, acceptance method, addresses/contact and effective date. |
| T2 | Approve account/data/workflow responsibilities, output review and acceptable-use rules, including enforceable scope. |
| T3 | Resolve **Anthropic hosting clause**, verify applicable Codex subscription terms, and document the organisation owner's acceptance of the permitted hosting and credential arrangement. |
| T4 | Customer support channel/hours, response expectations, maintenance/change notices and any availability commitment. |
| T5 | Fees, currency, taxes, billing/payment, price changes, cancellation/refunds and subscription/Sprite cost allocation. |
| T6 | Lawyer: warranties/liability, any cap/exclusions, third-party failures and non-excludable rights. |
| T7 | Lawyer/owner: suspension/termination, notice, export opportunity, data/fee consequences and urgent misuse. |
| T8 | Lawyer/owner: governing law, disputes, notices, amendments and remaining contractual clauses. |

## Evidence limits to resolve before publication

The drafts follow code where a broad plan sentence would overpromise:

- Cloudflare records currently set `proxied = false`: DNS is evidenced, edge traffic processing is
  not. Fly web/API and Neon are configured in Sydney; Sprite geography is separately recorded.
- Extracted text expires for reads within 24 hours and is deleted hourly, but whole-database dumps
  may retain it within the 30-day backup process. The notice distinguishes those periods.
- “Content is not logged” applies to inference usage/diagnostic logging. Durable step outputs can
  contain business content, including mail bodies; extracted attachment text is excluded.
- “Everything except a one-line record” describes live tenant deletion. Platform identities,
  authentication records, backups, provider-held records and operator-managed Sprites have separate
  lifecycles. The deletion record includes the deleting person's email and row counts.
- Support specifies investigation and escalation, not a response-time or uptime guarantee.
<!-- Sources: infra/tofu/dns.tf, neon.tf; docs/runbooks/inference-sprite.md;
apps/api/src/triage/expiry.ts, service.ts; .github/workflows/backup.yml;
packages/db/src/workflows-schema.ts; apps/api/src/organisations/lifecycle.ts;
packages/db/migrations/0001_foundation.sql, 0015_organisation_deletions.sql;
docs/runbooks/support.md. -->

The legal applicability question was checked against the
[OAIC's small-business guidance](https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/organisations/small-business)
and [APP overview](https://www.oaic.gov.au/privacy/australian-privacy-principles/australian-privacy-principles-quick-reference)
on 16 September 2026. Those sources inform P4; they do not establish this operator's coverage or
compliance. No provider contract permission or legal sign-off has been inferred from technical code.
