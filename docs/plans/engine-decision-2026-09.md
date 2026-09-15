# Durable execution decision — September 2026

**Recommendation: pg-boss with a small Captain runner (D19).** Job 1: triage the
inbox. This is the bounded D10 spike for #17, not the production runner for #18.
Both engines completed the same inbox-triage definition. Neither alone prevented
a duplicate when a destination write committed before its completion was journaled.
Restate made waits easier, but did not remove the destination idempotency work
that would justify another service for the first customer.

## What ran

On 2026-09-15, on the shared development machine: Node 22, a throwaway Postgres 18
database, pg-boss **12.32.0**, and self-hosted Restate **1.7.10** with TypeScript SDK
**1.17.0**. No Restate Cloud, Fly provisioning, live model, Gmail call or mail send.
Both engines were running their scenarios within 15 minutes of reading the brief;
neither reached the one-hour fallback. Restate's first registration failed because
its default discovery expected HTTP/2; explicit HTTP/1.1 discovery fixed it.

The comparison source is preserved in commit
[`66b61f8`](https://github.com/SomedaySomehowBeer/askthecaptain/commit/66b61f8).
The final tree retains pg-boss and removes the Restate adapter and SDK dependency.
[Recorded results](engine-spike-evidence.txt) preserve the comparison before removal.

Both adapters implement `Engine.start(definition, enablement, trigger)` and
`Engine.resume(runId, event)`. The same bounded interpreter walks the actual
`inbox-triage` definition from `@captain/steps`, including `each`, `branch`, `when`,
argument references and saved outputs. Loop indices appear in journal paths.
The fake catalogue returns three threads (two need the owner), invokes the model
package's `StubProvider` inside infer steps, inserts fixture drafts and records
fixture label effects. Other triage services are explicit no-op fixtures. Every
business write and journal mutation uses tenant context and the enabling person's
identity; the runtime connection cannot bypass RLS. Queue schema setup uses the
test owner separately. Queue jobs contain only a run ID, not mail, prompts or keys.

`engine_spike.outbox`, labels and fault markers exist only in throwaway test setup,
with forced RLS and cross-tenant checks. They are not production outbox tables or
migrations. `workflow_runs` and `workflow_run_steps` are the real journal from #35.
There is no new production migration or enabled background worker in this PR.

## Same scenarios, same assertions

| Scenario | pg-boss | Restate |
|---|---|---|
| Three threads: two drafts, each thread labelled once | Pass | Pass |
| Throw after committed draft write, before journal; retry without duplicate | Pass with destination key | Pass with destination key |
| Event arrives later, after stopping and recreating the worker/handler | Pass | Pass |
| `outbox.sent` never arrives; `timeoutDays` expires | Pass | Pass |
| Failed run identifies the step and reason | Pass, including read service | Pass, including read service |
| Negative control: remove destination key at the same failure boundary | **Three drafts instead of two** | **Three drafts instead of two** |

Thirteen tests passed, none skipped: six per engine and a tenant-isolation check.
For fast tests, a day is one second; the timeout scenario uses 100 ms per day, so
the definition's seven-day wait expires after 700 ms. These timings test semantics,
not production latency or load. The side-effect crash is the requested injected
exception, not a SIGKILL; the separate wait test closes and recreates the worker or
HTTP handler while durable state remains. We did not kill Postgres or the Restate
server or simulate disk loss/network partitions.

## Scores and evidence

Scores are judgements from this slice: 1 poor fit, 5 strong fit. They are not benchmarks.

| Criterion | pg-boss | Restate | What we saw |
|---|---:|---:|---|
| Exactly-once side effects without hand-written fences | 2 | 2 | Both repeated a committed draft without a destination key. Queue delivery or durable replay does not make the separate database write atomic with its completion record. |
| Timers and awaits | 3 | 5 | pg-boss needed a persisted deadline, `startAfter` job, event wake-up and replay from SQL. Restate used `ctx.sleep`, an awakeable and a durable race. |
| Incident journal | 4 | 4 | Both produced identical Captain run/step fields and readable failures. Restate additionally has its engine journal; that is useful, but requires correlating a second journal. |
| Operational weight | 5 | 2 | pg-boss uses the existing Postgres and application worker process. Restate adds a server, endpoint registration, durable storage, backup/restore, monitoring and upgrades. |
| Livable determinism rules | 4 | 3 | Both require pinned definitions and stable paths. Restate also requires I/O inside `ctx.run`, durable promise composition and preserving replay order; ordinary async code is not interchangeable. |
| **Total** | **18/25** | **16/25** | Operational simplicity decides this close comparison for one customer. |

At the comparison commit, physical runner sizes (`wc -l`, including comments):
**pg-boss 68 lines**, **Restate 72**, **shared interpreter/interface 30**, and
**shared DB journal 43**. This excludes fixture setup, tests and dependencies;
it is a measure of this thin experiment, not a forecast of production complexity.

### What restart looked like

pg-boss retried the failed job and the runner read completed step outputs from SQL.
The destination's `(organisation_id, run_id + step path)` key returned the existing
draft on retry. Closing and reopening the worker preserved a delayed timeout job;
a later owner event queued work that read the durable draft state and continued.

Restate suspended the HTTP/1.1 handler and replayed recorded `ctx.run` results.
After the injected crash it retried the uncompleted `ctx.run`; that callback
repeated the already committed draft write. With the same destination key it
returned the existing draft. After recreating the handler, the stored awakeable
resolved and replay continued. Its terminal failure needed an explicit mapping
into Captain's journal, just as pg-boss did.

### What the incident journal looked like

The real `WorkflowService.run` returned the same failure for each engine:

```json
{
  "state": "failed",
  "reason": "steps.1[0].steps.1 (classifyThread): Fixture classification unavailable",
  "step": "steps.1[0].steps.1"
}
```

The failed step also had kind `infer`, a SHA-256 input digest, null output and
`error: "Fixture classification unavailable"`. Successful steps retained their
validated outputs. Nothing inferred from an engine's status replaced this journal.

Settings → Workflows contains the **Activity** section; there is no separate
Activity route. It currently renders run state and reason, not expandable step
outputs. Its read service exposes the detailed step journal. The browser evidence
records the existing presentation, without adding a new screen to the spike.

A production-build Playwright check at **390 px and 1280 px** rendered two failures
created by the real spike adapters, with the same step and reason, no failed-page
notice and no horizontal overflow. [Phone Activity screenshot](engine-activity-phone.png).
The run list does not label the engine; the fixture trigger and API identify their
origins. This is the desired engine-independent presentation, but it does not yet
let an operator inspect step outputs directly in the page.

## Operational cost

**Restate:** another process to run on Fly, with persistent journal storage and an
operator-owned backup/recovery and upgrade procedure. The local single-node server
used approximately **189 MiB** after the scenarios, under a **512 MiB** container
limit. This is one local observation, not Fly sizing or a price estimate. An HTTP
handler is also required. No HA, recovery drill or dollar pricing was measured.

**pg-boss:** no additional service beyond the existing Postgres and application
process. It still consumes connections, polling/maintenance work and database
storage. Schema installation and upgrades must be operator-run; runtime workers
must use a non-bypassing role. Library-owned queue metadata is platform scheduling
state; tenant business data remains behind Captain's forced RLS policies.

## Boundaries before issue #18 can ship

This runner is deliberately **not mounted in the API**. Production work must:

- Make initial run creation and enqueue atomic, and persist event delivery/wake-up
  atomically or through an outbox. This spike uses separate calls for those handoffs;
  its injected failure is at the step-write boundary, not every possible handoff.
- Couple local writes and journal completion in one tenant transaction where possible;
  otherwise use destination idempotency keys. A remote provider must support a key,
  an idempotent desired-state operation or reconciliation. Do not promise generic
  exactly-once remote writes; D5 still leaves outbound mail for the person to send.
- Check the enabling person's current membership/capabilities, enabled state and
  definition version on continuation; preserve immutable definitions and parameter
  snapshots. Handle cancellation, inference-budget pauses and exhausted retries.
- Bound worker concurrency and connection use, design queue privileges/retention and
  tenant routing, and record infrastructure failures even when a step cannot finish.
- Add production catalogue services, mail/outbox migrations, connector tests and
  Activity step-detail UI through the normal plan/design process. The fake label
  ledger demonstrates retry behaviour, not Gmail's API contract.

## Reproduce the comparison

Use the comparison commit in an isolated checkout, install with `pnpm install
--frozen-lockfile`, and point `DATABASE_URL` to a throwaway Postgres 18 database.
Start the **local** container (ports bound to loopback):

```sh
docker run -d --name atc-engine-spike-restate --memory 512m \
  -p 127.0.0.1:18080:8080 -p 127.0.0.1:19070:9070 \
  --add-host=host.docker.internal:host-gateway \
  docker.restate.dev/restatedev/restate:1.7.10
ENGINE_RESTATE=1 flock /tmp/atc-build.lock pnpm --filter @captain/engine test
docker rm -f atc-engine-spike-restate
```

The test handler uses port 19081, reachable by the local container. Use a private
local machine/network; no handler or Restate endpoint belongs on the public internet
for this spike. `DATABASE_URL` must already be exported. At the final commit,
`pnpm test` runs the retained pg-boss scenarios without Restate or skipped loser tests.

## Final verification

After rebasing onto `main` with #35 and #41 and removing Restate, `pnpm check` passed and
`pnpm test` against throwaway Postgres passed **139 tests, zero failures or skips**.
The retained engine suite has seven tests; the separate comparison above passed
all thirteen against both engines before removal. The production web build and
phone/desktop Activity inspection passed. Local fixture servers, databases and
containers were cleaned up; no Fly resources or deployments were created.

## Primary references checked

- [Restate durable steps](https://docs.restate.dev/develop/ts/durable-steps): `ctx.run`, retry rules and deterministic I/O boundaries.
- [Restate external events](https://docs.restate.dev/develop/ts/external-events): awakeables and external resolution.
- [Restate timers](https://docs.restate.dev/develop/ts/durable-timers): sleep, durable timeouts and deployment-version lifetime.
- [pg-boss jobs](https://pgboss.io/api/jobs): `startAfter`, retries and job expiry.
- [pg-boss transaction adapters](https://pgboss.io/api/adapters): enqueue/completion can share an application transaction; that is a production follow-up, not a claim about this spike's handoffs.
