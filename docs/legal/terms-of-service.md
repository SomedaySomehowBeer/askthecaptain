# DRAFT — Terms of service

**16 September 2026 — for the owner's review; not yet in force.**

## Parties and agreement

These proposed terms describe Captain for a business and its authorised members. “Operator” means
the business providing Captain; “organisation owner” means the person managing your Captain
organisation. **TODO owner [T1]: insert the operator's legal name/address, contracting customer,
effective date, support contact and how an authorised customer accepts these terms.** These drafts
are not an agreement in force.
<!-- Sources: docs/plan.md §§1, 9, 11 Phase 4; party and acceptance details require owner decision. -->

## What Captain does

Captain is an administrative assistant: it triages mail, drafts correspondence, helps with calendars,
tracks projects and recurring duties, chases due work and invoices, and prepares briefs and answers
from saved business data. A person reviews drafts and sends correspondence from the outbox. Models
receive data and return validated outputs; they have no tools and cannot themselves act on accounts.
<!-- Sources: docs/plan.md §§1–3, 6, D2, D5. -->

Enabling a workflow authorises its defined steps in the enabling person's name. Deterministic code
can make local changes, such as suggesting tasks, completing a duty from matching confirmation,
updating contacts and preparing drafts, and can label mail. It does not ask for a separate approval
at each step. You remain responsible for deciding which workflows to enable and reviewing their
results. Asking a question on Today answers from data; it does not authorise an action or start a
conversation with memory of earlier exchanges.
<!-- Sources: docs/plan.md §§6, 10, 12, D3–D5; apps/api/src/triage/service.ts;
apps/api/src/answers/service.ts. Responsibility wording proposed for owner approval [T2]. -->

Saved data may be incomplete or out of date, and model outputs can be wrong. Review sources,
recipients, amounts, dates and draft wording before relying on them or sending mail. Captain shows
missing connections, incomplete syncs, unavailable inference and spent allowances where known. A
reminder, brief or push notification should not be your only way of monitoring an important deadline.
<!-- Sources: docs/plan.md §§3, 7, 10; docs/runbooks/support.md; apps/api/src/push/webpush.ts.
Reliance/responsibility wording is proposed for owner/lawyer approval [T2, T6]. -->

## Accounts and organisations

People sign in with Google and join explicitly created organisations or accept invitations using the
invited address. Roles are owner, admin and member. Members use the shared business records;
owners/admins manage membership, connections and workflows. Owners control inference runtime setup
and organisation deletion. A registered passkey is required at later sign-ins. Owners/admins can
export organisation data, including members' saved questions and answers.
<!-- Sources: docs/plan.md §9; apps/api/src/organisations/service.ts, lifecycle.ts;
apps/api/src/auth/passkeys.ts; apps/api/src/inference/service.ts; docs/plan.md §5 Answers. -->

**Proposed responsibilities — TODO owner [T2]: approve these rules.** You must be authorised to act
for the business, manage its invitations and permissions, protect your sign-in access and devices,
and tell the operator about suspected unauthorised access. Only connect accounts and supply data
that you are entitled to use for these administrative purposes, including information about other
people. Review and maintain your workflow settings and records.
<!-- Basis: docs/plan.md §§6, 8–9; these are proposed contractual obligations, not existing policy. -->

## Connected providers and inference subscription

Google, Xero and Shopify accounts remain your business's accounts. You are responsible for the
permissions you grant and maintaining the access needed for the jobs you enable. Reconnection may
be necessary if a provider revokes access or permissions change. Sending a draft requires a person;
if a send result is uncertain, use Check send and inspect Gmail as instructed before trying again.
<!-- Sources: docs/plan.md §§7–8, Inbox triage delivery detail; docs/runbooks/support.md;
docs/runbooks/inbox-triage.md. Contractual allocation proposed under [T2]. -->

Inference currently uses your organisation's own Claude or Codex subscription through the unmodified
CLI on a Captain-operated Fly Sprite dedicated to that organisation. Subscription login credentials
remain there. The model's tools are disabled. You must maintain the subscription and comply with the
inference provider's applicable terms; Captain's terms cannot grant rights that provider withholds.
<!-- Sources: docs/plan.md §7, D9, D18; docs/runbooks/inference-sprite.md.
Provider-contract allocation is proposed; no conclusion about provider permission is made. -->

**TODO owner [T3]: Anthropic hosting clause.** Resolve and document whether the intended Claude
subscription and Captain-operated hosting arrangement are permitted before operating it. Confirm the
applicable Codex subscription terms too, and obtain the organisation owner's informed acceptance of
the hosting arrangement, credential location and relevant processing locations. This draft does not
declare either provider's permission or treat customer acceptance as a substitute for it.
<!-- Sources: docs/plan.md §7; docs/runbooks/inference-sprite.md, Owner/operator setup and region note. -->

Captain checks a monthly token allowance before inference and records usage. An unavailable runtime
or exhausted allowance stops affected inference, with a visible reason. An allowance is not a dollar
price or a guaranteed provider-enforced ceiling; a Codex call can exceed its estimate. API-key
inference and cost budgets are not currently offered.
<!-- Sources: docs/plan.md §7; docs/runbooks/inference-sprite.md, Data-only invocation and Adding the API path. -->

## Acceptable use

**Proposed rules — TODO owner/lawyer [T2]: approve scope and enforcement.** Do not use Captain for
unlawful activity, deceptive or abusive mail, unauthorised access or sharing of others' data. Do not
bypass access controls or rate limits, attempt to reach another organisation's records, expose
credentials, or disrupt Captain or a connected service. No suspension or penalty mechanism is
established by this draft; termination provisions remain for legal review below.
<!-- Basis: docs/plan.md §§3, 9, D2, D5, D6; apps/api/src/ratelimit.ts.
These are proposed terms, not a claim that an acceptable-use policy has already been adopted. -->

## Availability and support

Support begins with Settings → Workflows → Activity, Connections and Inference. These show run
failures, reconnect needs and allowance/sign-in states. Reports should include the organisation ID,
relevant run ID, time in the organisation's timezone and expected result. The support process uses
the repository issue tracker; production-incident escalation is the operator owner's decision.
Support must not request provider tokens, Sprite secrets or the master key, and may inspect mail
bodies only when asked to look at a specific thread.
<!-- Sources: docs/runbooks/support.md, Where to look first, What you must not do and Escalation. -->

Captain depends on its hosting, connected providers, inference subscription and device push service.
A saved brief can remain available even when push fails. **TODO owner [T4]: set the customer-facing
support channel, support hours, response expectations, maintenance/change notice and any availability
commitment.** The present runbook specifies no uptime percentage, guaranteed response time or 24-hour
support promise; this draft adds none.
<!-- Sources: docs/plan.md §§4, 6–8; docs/runbooks/support.md, web-push.md. -->

## Fees

**TODO owner [T5]: decide pricing, currency, taxes, billing frequency, payment terms, changes,
cancellation and refunds; identify who pays for subscriptions and Sprite hosting.** Token allowances
are technical usage controls, not agreed fees.
<!-- Sources: docs/plan.md §7 and §14 Open questions. -->

## Data handling

The [draft privacy notice](privacy-notice.md) describes collection, providers, access, security,
retention and requests. Owners/admins can export business data without credentials from Settings →
Your data. Only the owner can delete the organisation there; live tenant data is removed and a
deletion record remains. Backup expiry, platform account records, external-provider data and manual
Sprite cleanup have the limits stated in the notice. Deleting an organisation does not by itself
cancel your third-party subscriptions.
<!-- Sources: apps/api/src/organisations/lifecycle.ts; docs/runbooks/backup-and-restore.md;
docs/runbooks/inference-sprite.md; docs/legal/privacy-notice.md, Retention, export and deletion. -->

## Matters reserved for legal review

- **TODO lawyer [T6]: liability and warranties.** Draft any allocation of loss, liability cap,
  exclusions and treatment of third-party failures, preserving applicable non-excludable rights.
  No cap, indemnity or waiver is proposed as an operative clause here.
- **TODO lawyer/owner [T7]: termination and suspension.** Decide grounds, notice, customer exit,
  export opportunity, effects on fees and data, and the treatment of urgent misuse incidents.
- **TODO lawyer/owner [T8]: governing law, disputes and changes.** Confirm jurisdiction, dispute
  route, notices, amendment process and any other clauses needed for the actual contracting parties.
<!-- Sources: AGENTS.md, How work moves (legal decisions belong to the repository owner);
docs/plan.md §§9, 11 Phase 4. These placeholders are not legal conclusions. -->
