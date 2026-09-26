# Sign-in return verification — 27 September 2026

Outcome: protect access to shared work. #175 fixes the Work layout overriding task/project sign-in
destinations; #176 validates API and web return paths, including stored requests from older releases.
One Claude Opus agent implemented the security fix, the other independently reviewed it, and Codex
reviewed/integrated it and added browser checks. Release-script review findings were resolved before
execution. No schema, session format, credential, dependency or production rate-limit change.

## Checks

- Workspace typecheck: ten packages passed (seven unchanged checks cached).
- The first full test run exposed fixture rate-window exhaustion. The tests now inject a clock
  that advances between cases while retaining actual limits within each case. Fifteen focused
  API/auth tests passed after the correction.
- Final full local real-Postgres run: **478 passed**, zero failures/skips, all eight test tasks
  uncached. API 193, web 128, database 97, engine 20, connectors 17, model 11, retrieval 7, steps 5.
- Production web build passed. The complete local Chat views suite passed with unsafe/repeated
  return paths, zero off-site navigation attempts and a valid Unicode link. The #175 task/project
  return regression passed independently; CI verified both fixes together.
- [CI 36274608736](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36274608736)
  passed both jobs on `41e7939`: typecheck, all 478 tests, 13 infra-service tests, React retry
  regression, production web build and both complete two-person Chat browser suites.
- Clean-source API and web Docker builds passed. Source `41e7939d2fe13e69367e9d6d275f1b9fc2b4f946`
  and merge `23c672b066b0c623b05ada3ecdb293aa3eeacc65` share tree
  `eaf35b9917b147951d42d87cf0f52e141e9dcea4`.

## Hosted evidence

The [release record](../../runbooks/paused.md#sign-in-return-fixes-27-september-perth--26-september-2026-utc)
records exact image/index digests and retained configuration. Anonymous Chrome checked eight
protected destinations at 390 and 1440 pixels: Chat list, filtered list, views, new-with-task, thread,
details, task and project. Every destination survived the sign-in redirect, with no horizontal
overflow or page errors. Three unsafe sign-in parameters produced a Google link with a safe home
return. No Google flow was started and no hosted business records were written.

The deployed API passed its restricted-role guard and reported `captain_runtime` for both current
and session role. Its compiled validator retained a valid local query/fragment, rejected the
backslash escape, and its start endpoint returned 400 `return_to_invalid` for two unsafe paths.
Readiness returned 200. The probe read no business content and made no business-data writes.

Fleet comparison passed: one machine per staging app, only their images changed, production and
embedding identities/configurations unchanged and stopped, automatic deploy/backup still disabled.
No migration, queue installation or credential operation occurred.

These hosted checks cover deployment, anonymous protection and destination validation. Actual
signed-in/two-person interaction is proven locally and in CI, not in a hosted signed-in session.
Staging multi-user polling capacity, native-device acceptance and real identity-provider interaction
remain unclaimed.
