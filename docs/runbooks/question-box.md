# Today questions

> **Retired implementation:** the assistant runtime is removed in #135. Commands below are
> historical recovery context, not current setup instructions. Do not re-enable these sources.
> Follow the [retirement contract](../plans/assistant-runtime-retirement-2026-09.md), including
> stopped-worker cutover, embedding shutdown and deliberate provider-grant handling.


> **Legacy assistant maintenance reference (25 September).** This describes code still present,
> not current Captain scope or workspace onboarding. Its old job/decision/plan-section references
> belong to the [historical plan](../plans/legacy-assistant-history.md). Do not enable this path
> as a prerequisite for Work/Chat/Resources; retirement does not wait for Pip. Follow the
> [implementation inventory](../plans/captain-workspace-migration-inventory-2026-09.md) for cleanup.
> This status note does not itself stop a running process or establish live enablement.

Job 6: brief and answer. Migration `0025_answers.sql` is applied by the API release step. No new
configuration, queue or resource is needed. An active member with ready inference and sufficient
monthly token allowance can ask a question at the bottom of Today. Each question is independent;
Captain reads saved data and cannot act on a request. No previous exchange is sent to inference.

Try “What tasks are overdue?”, “Mail with Alex Supplier last month”, “Meetings today” or “Unpaid
invoices for Supply Co”. The rules match whole name words or exact emails, so use a full name or email
when a first name is ambiguous. Date words use the organisation's timezone. Calendar defaults to the
next seven days; mail never goes beyond 60 days. Invoices retain currencies; paid invoices use their
fully-paid date, not cash receipts. Stock is the latest saved observation, not a historical ledger.
Every source is capped at 20 rows. Limits and connection/sync gaps stay in the answer even when the
model omits them. The model receives subjects/snippets, not mail bodies, attachment text or keys.

Unavailable inference links to Settings → Inference. An owner finishes subscription sign-in and
verification; an owner/admin changes the monthly allowance. The existing inference client refuses a
call that would exceed the remaining allowance. The question endpoint allows 30 attempts per hour
per organisation (the existing process-local limiter; resets on restart). A failed schema is retried
once by the inference client, with both calls charged, and never saved as an answer. Source ids that
were not retrieved are dropped; links and labels are supplied by code. Unknown evidence lowers
confidence, and an unsupported answer is replaced with a request for more specific data.

Recent history shows only the asking person's exchanges and is not conversation context. Exchanges
are append-only, tenant-isolated, included in owner/admin organisation exports, and removed with the
organisation. `model_usage.step_key = 'answer'` records calls without a workflow run; `answers.model`
is the actual provider-reported model. `answer.created` audits the asking member. If a response is
lost after a save, reload Today and check recent questions before resubmitting.

Validation: `DATABASE_URL=… pnpm --filter @captain/api exec node --import tsx --test
src/answers/answers.test.ts`, then the full check/tests under the shared build lock. Browser checks use
a production web build on Today, including signed-out 307, source links, recent history, reading,
empty, failed, unavailable and spent-budget states. Keep fixtures synthetic and remove them afterward.
