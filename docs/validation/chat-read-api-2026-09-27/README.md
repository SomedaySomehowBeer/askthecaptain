# Chat read API validation — 27 September 2026

Outcome: discuss work (D25), preserving participant isolation (D6). Reviewed #173 adds the
bounded read prerequisites for the adopted Chat web plan: composable SQL-filtered views with
view-bound keyset cursors, author names, hydrated original pin messages and bounded list excerpts.
Detail retains its existing links array; list rows use `linkSummary`.

- 41 focused API/app/lifecycle tests passed against disposable PostgreSQL 18 as `captain_runtime`.
- Workspace typecheck passed: 10 packages, 9 unchanged cached results.
- Full regression: **419 passed**, no failed/skipped or cached tests, 8 packages (3m35s).
- Clean-source API image build passed.
- [CI 36267925576](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36267925576) passed.
- Claude Opus reviewed the API diff independently; reciprocal review corrected the web handoff's
  transport shapes and pending/reconciliation details. Root corrected plan wording on live pins.

The existing staging API machine received only the new image. No migration, dependency, rate-limit
or write-behaviour change was needed. A read-only deployed probe returned:

```
CHAT_READ_RELEASE_PASS {"role":"captain_runtime","session":"captain_runtime","forced_tables":8,"checks":["runtime role guard","eight forced-RLS chat tables","deployed filter schema","readiness"],"writes":0}
```

Fleet comparison passed: one machine per staging app, unchanged web/production/embedding
configuration, production/embedding stopped. No hosted business content was read or changed;
temporary verification code was removed. Exact source/image and rollback constraints are in the
[runbook](../../runbooks/paused.md). This is API/runtime evidence, not Chat UI or two-person browser
acceptance; web implementation remains in progress.
