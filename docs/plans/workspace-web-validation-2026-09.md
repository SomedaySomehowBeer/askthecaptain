# Web workspace foundation validation

Job: **own commitments**. The first web increment of delivery slice 2 is checked against a real,
disposable PostgreSQL 18 database with pgvector, the real API and a production Next build. No
hosted data, provider credentials, inference or schedules are used. Chat and file availability
pages do not claim those products have shipped.

## Reproduce

Use a private temporary directory for the short-lived fixture session. Commands assume the repo
root and installed dependencies. `DATABASE_URL` must name a local throwaway Postgres admin
connection: the harness creates, migrates and drops a separate database. The fixed ports 8084 and
3034 must be free.

```bash
export WORKSPACE_PROBE_DIR="$(mktemp -d /tmp/captain-workspace.XXXXXX)"
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:32784/postgres
# Keep this foreground process in its own terminal; stop with Ctrl-C to drop the fixture DB.
pnpm --filter @captain/api exec node --import tsx test/workspace-fixture.ts
```

In another terminal, using that same `WORKSPACE_PROBE_DIR`:

```bash
export NEXT_DIST_DIR=.next-workspace
export API_URL=http://127.0.0.1:8084
export APP_URL=http://127.0.0.1:3034
flock /tmp/atc-build.lock pnpm --filter @captain/web build
pnpm --filter @captain/web exec next start --hostname 127.0.0.1 --port 3034
```

The optional `NEXT_DIST_DIR` keeps this build away from an existing development server. Next
rewrites `apps/web/next-env.d.ts` and `apps/web/tsconfig.json` for the selected directory; restore
those generated changes after the check, and do not commit a local output path.

Run the browser script in a third terminal:

```bash
flock /tmp/atc-build.lock node apps/e2e/scripts/workspace-check.cjs
```

It uses installed Playwright Chromium by default. On the shared droplet browser, set
`CHROME_CDP_URL=http://127.0.0.1:9222`; the script opens and closes its own clean session and uses
a Node loopback bridge because Chromium is containerised. The bridge adapts navigation redirects;
the script separately asserts the actual server's signed-out HTTP redirects. It does not alter
app responses or records. Streaming timing and native-device behaviour are not established by
this bridged browser check.

## Coverage

- Signed-out routes redirect before streaming; `/` defaults to My work.
- Default owner/status, owner/tag filters and missing lookup preservation use real API records.
- Completed task links reveal the existing Commitments record; cancelled rows explain the missing detail.
- Invalid, empty and failed reads remain distinct.
- A browser-created task persists with the selected project and current owner.
- Pagination retains filters; Inventory stays in Resources without overwriting Work's last route.
- Grouped view lists, retained Today, phone/desktop layouts and browser exceptions are checked.
- Screenshots are saved beside the fixture session, outside the repository.

The web unit suite checks filter boundaries and navigation restoration validation. Real-Postgres
regressions cover the project `state` field required by both Work filters and Commitments sections,
and the morning brief's `/today` notification destination. The full CI suite remains required.
Native iOS/Android, Safari/Firefox and the full slice-2 acceptance workflow remain outstanding.
