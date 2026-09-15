# Issue #11: a synchronous React retry was lost

Job 4: own commitments. Investigated from main `93b2012` on 16 September 2026
(Perth). The issue is in Next 15.5.25's bundled React renderer.

## Cause and fix

A populated Commitments page can receive a complete server-action response while
its transition remains suspended. In the captured failure, React read a pending
Flight chunk, yielded, then attached its retry listener after the chunk had
become `resolved_model`. Attaching the listener initialized the chunk and called
React back **synchronously during rendering**. The chunk became fulfilled, but
the transition's lane remained suspended with no pending retry. There were no
browser console or hydration errors, and the response decoder had no pending or
blocked chunks.

`pingSuspendedRoot` avoids restarting a render from inside that render. The old
branch also omitted recording that this work was ready to retry. The missing
bookkeeping is the upstream fix in
[React #36134](https://github.com/react/react/pull/36134), merged 24 March 2026.
The narrow [pnpm patch](../../patches/README.md) supplies it to Next's four regular
client/profiling bundles. No framework major-version upgrade is needed.

Package manifests resolve React and React DOM **19.3.0**, but the App Router's
actual browser renderer reports **19.2.0-canary-0bdb9206-20250818**. Both the
bundled source and React's browser DevTools hook confirmed that difference.
Changing only the app's React package would miss the affected code.

The shared save handler now uses a React action transition, retains entered
values on failure, and resets the form after a confirmed save. Task, stock,
workflow and Shopify writes revalidate their pages. The document reload
workaround is removed.

## Evidence

All browser measurements used a production build and real Chrome on loopback.
Populated runs used a fresh Postgres database, 70 seeded tasks and 25 monthly
series (which also generate occurrences). Each successful probe added a task,
so the form count grew during a run; this was not a fixed-count statistical
comparison.

| Probe | Result |
| --- | --- |
| One action-state form with N plain forms, N = 0/1/20/70/150/350; revalidation on, plus N = 70/350 without it; 1-second idle | 32/32 settled |
| N = 70/350, with and without revalidation, plus Suspense variants; 12-second idle | 24/24 settled |
| Original direct action-state form on the populated page; 12-second idle | 1/8 stuck after a complete response; two further instrumented runs captured the same stall |
| Focused synchronous-resolution page, same production build before/after the single retry fix | 4/4 stuck before; 4/4 settled after |
| Populated page with only that renderer fix; 12-second idle | 12/12 settled |
| Checked-in browser regression against the installed dependency | Failed unpatched; passed patched |

Form count alone did not trigger the minimal case, so there was no failure
threshold to bisect. Removing revalidation shrinks the response but does not
identify the cause. The focused synchronous-resolution probe supplies the
repeatable failure that the form-count matrix lacked. Diagnostic logging changed
the intermittent failure rate; successful individual runs were not treated as
proof of a fix.

CDP response-body captures sometimes failed on otherwise successful actions;
these were recorded separately from console errors. Chrome can also re-encode
non-ASCII text in this capture API, so recorded sizes/hashes describe the captured
representation, not a claim about exact bytes on the wire. Replaying one captured
response as a buffered body settled, but was not treated as a byte-exact network
replay. No captured tenant response or session token is committed.

Final validation after rebasing onto main `96ae0f0`: repository typecheck, 229
tests against Postgres (zero skipped),
a fresh production build, and desktop/phone checks of task creation/completion,
failed-input retention, stock creation/count/archive, workflow toggles/parameters,
Today completion, and Shopify sync/reorder/disconnect. Successful saves made no
new document request. `/dev/pending` returned 404 in production even with the
local opt-in set.

## Run the regression

This test loads Next's installed production React DOM renderer in an isolated
browser page. It needs neither a web/API server nor a session. The component
makes data ready during a sibling render; the requested and displayed revisions
must both reach 1. It fails deterministically without the patch.

```sh
pnpm --filter @captain/e2e exec playwright install chromium
flock /tmp/atc-build.lock pnpm --filter @captain/e2e exec playwright test react-retry.spec.ts --project chromium
```

On the shared machine, wait for more than 1500 MB available memory before heavy
commands, and hold `/tmp/atc-build.lock`. CI installs Chromium and runs the test.

## Interactive diagnostic page

`apps/web/src/app/dev/pending/` contains the focused probe and the original
form-count matrix. **The page and both actions reject production mode**, missing
opt-in, and non-loopback `APP_URL`. It uses no business data or credentials.

For development, start the web app with `CAPTAIN_REPRO_LOCAL=1` and a loopback
`APP_URL`, then visit:

- `/dev/pending?sync=1`: synchronous-result regression.
- `/dev/pending?n=70`: one action-state form and 70 plain forms, with revalidation.
- `/dev/pending?n=70&refresh=0`: without revalidation.
- `/dev/pending?n=70&suspense=1`: wrap the plain forms in Suspense.

N is bounded to 0–500. `apps/e2e/scripts/pending-repro.cjs` automates the count
matrix. Set `PROBE_ORIGIN` to the local web address and optionally `CHROME_PATH`.
It accepts `PROBE_CASES` (JSON query objects), `PROBE_REPEATS`, and `PROBE_IDLE`
(milliseconds), and emits JSON lines with results. Failed attempts also save
HTML and a screenshot. Defaults: eight cases, four attempts, 12-second idle.

To reproduce the historical **local production** page experiment, use a
disposable checkout: remove only the `NODE_ENV === 'production'` clause from
`guard.ts`, keep the opt-in and loopback checks, build, and bind `next start` to
127.0.0.1. Restore the guard before committing. Never run this override on a
deployment. The isolated regression above avoids needing that override.

A manual seeded fixture is available in `apps/api/test/pending-fixture.ts`.
Set `DATABASE_URL` to a throwaway Postgres and `PROBE_SESSION_FILE` to a new path
under `/tmp`, then run it with `pnpm --filter @captain/api exec tsx test/pending-fixture.ts`.
It creates a fresh database, serves on 127.0.0.1:8108, and writes a mode-0600
session file. Point the local web server's `API_URL` there, use the token as the
`captain_session` cookie, and stop the fixture with Ctrl-C to drop its database
and remove the session file. It exposes Commitments; other service sections show
unavailable states. Tokens and screenshots containing business data must stay
outside the repository.
