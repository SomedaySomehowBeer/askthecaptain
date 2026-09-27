# Remote session revocation contract

Status: adopted by this planning amendment, 27 September 2026. Outcome: **manage shared work** through secure account access.
Independently reviewed by both existing Claude Opus agents and root. No implementation is included.

It implements foundation §4 "Remote revocation" and §9 step 6 (#178) at the foundation's small scope: **end the
person's existing sessions, other than the current one.** It is a per-person control, required before
first-customer native readiness.

## 1. What exists today (read from source)

**The `sessions` table** (`0001_foundation.sql:36` and `0018_passkeys.sql:20`)
- Columns: `id uuid`, `user_id`, `token_hash` (unique, SHA-256 hex), `expires_at`, `revoked_at` (nullable),
  `created_at` and `passkey_verified_at`. It is indexed on `user_id`.
- It has no device, platform, user-agent, IP or last-used column, and this contract adds none.

**Scope and access**
- `sessions`, `users` and `auth_events` are **global platform tables**, scoped to a person rather than to an
  organisation (`0001_foundation.sql:3`). They have no RLS, and none is added here.
- Tenant RLS keys on `current_organisation_id()` and does not apply to them. Isolation for this route comes from the
  query: `where user_id = $me`, where `$me` and `$current` come only from the verified bearer. The route accepts no
  identifier, so it cannot reach another person's rows.
- **Actual grants:**
  - `0001` grants `app` select, insert, update and delete on `sessions` and `auth_requests`, and select and insert on
    `auth_events`.
  - `0041_runtime_role.sql` creates `captain_runtime` (nobypassrls, not an owner) and copies `app`'s direct
    privileges to it, without grant option.
  - So the runtime role the API uses already has the `update sessions` and `insert auth_events` this route needs.
    No grant changes, and `runtimeRoleIsSafe` is unaffected.

**API** (`apps/api/src/app.ts`)
- **Signed-in routes:** the `signedIn` sub-app runs `requireSession` on the bearer, which answers 401 for a missing,
  revoked or expired session. It exposes `session.id` and `session.userId`.
- **Rate limits:** per IP on `/v1/*` (300 a minute), and per person (600 a minute).
- **Sign-out:** `POST /auth/sign-out` revokes only the presented token (`auth/service.ts:185`). No `revoke-others`
  route exists.
- **Locks:** there is precedent for a per-person advisory transaction lock (`lockPasskeys`, `auth/native.ts:66`).

**Web**
- The HttpOnly `SameSite=Lax` cookie `captain_session` is sent to the API as a bearer, from the server only.
- Per-person writes are Next server actions, as in `settings/passkeys/actions.ts`.
- The Settings "You" card holds Passkeys and Sign out.

**Mobile**
- The token lives only in the account runner.
- `ApiClient.post` exists.
- `apiPaths` is a fixed allow-list.
- The Account screen is `src/app/settings.tsx`.

## 2. API: `POST /v1/me/sessions/revoke-others`

This is an ordinary signed-in write. There is no approval layer, confirmation token, step-up or new header.

**Input:** none. The body is ignored.

**One transaction** at the default isolation level, READ COMMITTED:

1. **Lock.** `select pg_advisory_xact_lock(hashtextextended('captain.sessions:' || $me, 0))`. This serialises this
   route's calls for one person. It does not serialise sign-ins, which do not take this lock.
2. **Check the current session.** `select 1 from sessions where id = $current and user_id = $me and revoked_at is
   null and expires_at > statement_timestamp()`.
   - **Why `statement_timestamp()`, not `now()` (root's finding).** `now()` is the transaction's start time, which is
     taken **before** the advisory-lock wait in step 1.
   - With `now()`, a session that expired while this call was queued on the lock would pass the check. That would
     contradict "still live after the lock".
   - `statement_timestamp()` is taken when this `select` starts, which is after the lock is held.
   - If there is no row, answer **401** and record `auth.sessions.revoke_others` with `success = false` and detail
     `{reason: 'current_session_ended'}`.
   - This catches a concurrent call that ended this session after the middleware check.
   - The failure is **returned** from the transaction, not thrown, so its event commits. The 401 is thrown after the
     commit (§5a.1).
   - `requireSession` compares against the API's clock, but step 2 compares against the database's statement time.
     A session that expires between the two checks, including while it waits on the lock, gets a 401 from step 2.
     That is correct and harmless. Tests control the expiry explicitly and never rely on clock boundaries (A's S2,
     corrected by root).
   - **What step 2 promises.** The current session was live when step 2 ran, and **this call** excludes it from the
     revocation.
     - It does **not** promise the session is still live when the call returns, or at any later time.
     - A concurrent `signOut` of the same token (`service.ts:187`), or the session expiring, takes no sessions lock,
       and can end it right after step 2.
     - The client then sees 200, and its next request gets 401. That is the existing session-ended path.
3. **Revoke** (one statement, so `statement_timestamp()` has one value throughout it):
   ```sql
   with revoked as (
     update sessions set revoked_at = statement_timestamp()
     where user_id = $me and id <> $current and revoked_at is null
     returning expires_at)
   select count(*) filter (where expires_at > statement_timestamp())::int as ended from revoked
   ```
   - `ended` counts the sessions that were active at this statement's time.
   - `revoked_at` records the same instant, which is the start of the revoking statement.
4. **Record** `auth.sessions.revoke_others` with `success = true`, `user_id = $me` and detail `{ended}` (a count
   only).

**Response:** `200 {"ended": <int>}` and nothing else. It contains no IDs, dates, hashes, tokens or metadata.
- `ended` is **the number of unexpired sessions this call ended**.
  - Sessions revoked concurrently by another path are skipped by the `UPDATE`'s recheck, and are not counted (A's S3).
  - It is a Postgres `int` from `count(*)::int`, so it is a non-negative safe integer.
- Clients accept it only if `Number.isSafeInteger(ended) && ended >= 0`. Anything else counts as **unknown**.

**Cutoff and concurrency (stated exactly)**
- **Cutoff.** Under READ COMMITTED, the step 3 `update` takes its own snapshot when that **statement** starts, not
  when the transaction starts.
  - A session committed before step 3 begins is revoked, unless it is the current session.
  - A session committed after step 3 begins is not seen, and survives.
  - `revoked_at` is the revoking statement's `statement_timestamp()`. It is taken when that statement starts, which is
    close to the snapshot but is a record, not the cutoff itself.
  - `now()` is not used anywhere in this route. It would be the transaction's start, which comes before the lock wait.
- **Not an account lockout.** Sign-ins already in progress may still create sessions after this call returns:
  - a Google flow in flight;
  - an exchange code, native handoff or passkey step-up already issued;
  - any new sign-in.

  Revocation ends the sessions it saw. It does not stop the person's Google account from signing in again. (Ending
  pending codes was considered and left out: they are issued under different locks, and an exchange already in
  flight can still win the race, so no guarantee would be true.)
- **Repeats.** Each call acts on the sessions visible to that call.
  - With nothing new, a repeat ends 0.
  - If sessions were created in between, a repeat ends those. Repeating is always safe, but it is not a
    guaranteed no-op.
- **The current session is excluded by this call; it is not guaranteed to stay live.** The sessions lock serialises
  only this route. A sign-out, an expiry or another path can still end the current session afterwards (step 2).
- **Two of the person's sessions calling at once.** The lock orders them. The first succeeds and revokes the
  second; the second then fails step 2 and gets 401, which its client already treats as "Your session has ended".
  Racing two sessions cannot end both, and cannot deadlock.
- **Expired sessions.** Expired sessions that were never revoked are revoked too, as in the foundation's SQL. They
  are not counted, because they were already unusable. Sessions already revoked keep their `revoked_at`.

**Outcomes the client sees**
- **200:** ended, with the count.
- **401:** the session has ended (the middleware or step 2 said so).
- **429:** rate limited, with `retry-after`.
- **Any other 4xx** (`refused`): for example a 404 from an API without the route, or a 403 from a proxy.
  - This route produces no other 4xx after a commit, but a proxy can.
  - So the wording claims neither success nor that nothing changed (A's R2).
- **Anything else:** 5xx, status 0, a timeout or a body that can't be parsed. **Whether the write committed is
  unknown:** a commit can be followed by a failed or unusable response. The wording never says nothing changed.

**Rate limit.** A new policy `sessionRevocations`: 5 a minute per person, keyed `revoke:{userId}`, for
`POST /v1/me/sessions/revoke-others` only. It is added next to `chatWrites`, after the existing IP and per-person
policies, and uses the existing 429 shape.
- It has the same shape as `chatWrites`: `POST` and the exact path, otherwise `null`. It runs after `requireSession`
  (`app.ts:128-132`), so `session.userId` is set.
- A 429 records **no** `auth_events` row. That is consistent with every other route (A's S1).

**Secrets and metadata**
- No token or hash appears in any response, event detail, error or log.
- Event detail holds counts and the reason only; `request_id` is already recorded.
- No client or device is recorded or guessed.

**Not in scope**
- Session or device listing, and revoking one chosen session.
- Last-used times or device names.
- Ending pending sign-in codes, and account lockout.
- Sliding expiry, and admin revocation of other people's sessions.

## 3. Web: the Settings "You" card

**Control**
- A secondary button, **"Sign out everywhere else"**, placed beside Passkeys and Sign out.
- It has one in-page confirmation step, which is UI and not an approval: "Sign out of Captain in every other browser
  and app where you're signed in, including on phones? This browser stays signed in." The choices are "Sign out
  everywhere else" and "Cancel".

**Write**
- A Next server action sends the cookie's token from the server.
- CSRF protection comes from the server-action origin check and the `SameSite=Lax` cookie. There is no new route
  handler and no change to `allowedOrigins`.
- The action uses `readSession()`, not `actionSession()`, because the write is per-person and needs no organisation:
  - **Signed out:** nothing is sent, and the page says "Your session has ended. Sign in again; nothing was sent."
  - **Unavailable:** the existing "…nothing was sent…" wording. That wording is true here because the check fails
    before any request is made.

**Results** (plain text, no identifiers)
- **N > 0:** "{N} other active session(s) ended." Then: "Anything already open on another screen stays visible
  until that screen next checks with Captain. Sign-ins already in progress, and new sign-ins, can still start new
  sessions."
- **0:** "No other active sessions were ended."
- **401:** the normal signed-out path.
- **429:** "Too many attempts. Try again in {n} seconds."
- **Refused (any other 4xx):** "Captain couldn't sign out your other sessions." There is no claim about what changed.
- **Unknown** (5xx, network, timeout, or an unparseable or out-of-range body): "Captain couldn't confirm whether your
  other sessions were ended. It's safe to try again."
  - Neither this wording nor the refused wording ever says nothing changed.
- There is no automatic retry, and this browser's cookies are unchanged.

## 4. Mobile: runner-owned revocation, Account screen control

The runner, not the screen, owns everything that must survive a remount or an account change.

**Binding (token-free)**
- `revokeOthers(expected: PersonScope)`, where `PersonScope = { epoch, userId }`.
  - `epoch` is the account generation, which advances on every sign-in, sign-out, session end and account switch.
  - `userId` comes from the signed-in snapshot.
  - It contains no token, handle or hash.
- The screen captures the scope when the confirmation is shown, and passes it on confirm.

**Before sending** (synchronous up to the send, like `organisationRead`)

The call answers without sending in any of these cases:
- **`stale`:** the account is not signed in, or the current person scope differs from `expected`. This covers ABA
  (sign out and back in as the same person advances `epoch`), a switched account, and a control confirmed on an old
  screen.
- **`in-flight`:** a revocation is already in flight for this scope. This covers a duplicate press, or a press after
  a remount.
- **`waiting`:** a server `Retry-After` wait recorded for this scope has not passed on the shared clamped clock.
  This covers a remount or re-entry while waiting, so the wait can't be bypassed.

Otherwise the runner records the current handle internally, marks the call in flight for the scope, and sends
`client.post(apiPaths.revokeOthers, token, {}, parse)`.
- `parse` accepts `{ended}` only when `Number.isSafeInteger(ended) && ended >= 0`. Anything else counts as
  unknown.
  - That includes an oversized or unreadable 200, which the #202 byte budget already reports as unavailable.
- The new fixed path is `apiPaths.revokeOthers = '/v1/me/sessions/revoke-others'`.

**After the answer**
- **Clear in-flight.** In-flight is cleared for the sent scope in every case: ok, error, rejection or stale.
- **401.** If the handle recorded at send is **still the current handle**, dispatch the existing `unauthorised`
  event for it. That ends the session with the existing wording. A 401 for an old handle is ignored **before any
  dispatch**, and the call answers `stale`.
- **Scope changed.** If the scope or handle changed while the call was in flight, answer `stale`, whatever the
  server said. No result is shown against a different account.
- **Waits.** A 429 or 5xx carrying `Retry-After` records a `wait` for the scope, runner-held, on the shared clock.
  The `/v1/me` wait is never touched. A wait belongs to its scope and is dropped when the scope changes.
- **Outcomes.** `RevokeOutcome` is one of:
  - `{ok, ended}`
  - `{unknown, wait | null}`
  - `{refused, status}`
  - `stale`, `in-flight` or `waiting`
  - `client-bug`
  
  It never rejects, and no outcome or snapshot holds the token.
- **No `/v1/me` refresh.** The API showed the current session was live at step 2, and memberships are unchanged. If
  the session ends later by another path, the next request's 401 takes the existing session-ended path.
- **Runner-held state.** `revocationView(): {inFlight, wait, last}` is exposed for the current scope and delivered
  through the existing subscription.
  - `last` is the latest result for this scope, so a remounted screen shows the pending state or the result
    honestly.
  - All of it is discarded when the scope changes.

**Screen**
- The button sits below Sign out: **"Sign out everywhere else"**. Its confirmation says: "Sign out of Captain
  everywhere else, including web browsers on computers? You'll stay signed in on this phone."
- While the call is in flight, the button is disabled and shows "Signing out everywhere else…". After ten seconds it
  also shows "Still waiting for Captain…", using the existing slow timer. The timer changes wording only.
- Leaving the screen cancels nothing, and re-entering shows the runner's state.
- The results use the same wording as the web, with "this phone" in place of "this browser". That includes the
  `refused` wording, "Captain couldn't sign out your other sessions.", and the `unknown` wording. Neither claims that
  nothing changed.
- While a wait is active, the button is disabled and says when Try again becomes available.
- There is no automatic retry.

**Flags.** The control renders only when the person is signed in. Native sign-in therefore stays off exactly where
it is today, and no flag changes.

## 5. Increments and tests

Each increment is its own PR, reviewed before the next begins.

**1. API.** The route, `AuthService.revokeOtherSessions(session, requestId)`, the rate-limit policy, and
real-Postgres tests as the runtime role. The tests check that:
- other live sessions are revoked, and the current session still passes `requireSession`;
- `ended` counts only unexpired sessions;
- another person's sessions are untouched;
- sessions already revoked keep their `revoked_at`;
- expired sessions are revoked but not counted;
- a repeat ends 0, and a session issued between two calls is ended by the second;
- a body naming another session or person changes nothing;
- a revoked or expired current session gets 401.

And, specifically:
- **Concurrency.** Two sessions of one person, on two connections, with the first holding the lock: exactly one
  200, one 401, and one session left live.
- **Cutoff.** A session committed while the first transaction waits on the lock is revoked, because it is visible
  to the update statement's snapshot. A session committed after the revoking statement began survives. This is
  tested with explicit transaction ordering.
- **Events.** The event rows have the right shape, and `detail` is exactly `{ended}` (or `{reason}` on failure).
- **Secrets.** A scan of the response, event detail and captured logs finds no `sess_` and no stored hash.
- **Rate limit.** The sixth call in a minute gets 429 with `retry-after`, and no event row.
- **Refused revalidation.** See §5a.1. Tests control expiry explicitly and never rely on a clock boundary.
- **Expired while waiting on the lock (root's finding, deterministic).**
  1. A test connection holds the same `captain.sessions:{userId}` advisory lock in an open transaction.
  2. Start the revoke request, and wait until `pg_locks` shows its backend waiting on that advisory lock. Its
     transaction, and so its `now()`, has started.
  3. As the owner, commit `update sessions set expires_at = clock_timestamp() where id = $current`. The new expiry is
     later than the revoking transaction's `now()`, and earlier than any later statement.
  4. Release the lock.
  5. Expect a **401** with one `success = false` event, and the other sessions unchanged.

  With `now()` in step 2, this would wrongly pass.
- **Counted at statement time.** The same set-up, but the clock-timestamp expiry goes on **another** session, not the
  current one. Expect it to be revoked but **not counted**: `ended` excludes it.
- **The current session is not guaranteed afterwards** (optional). This test runs only if it can be ordered without
  adding a production test hook; otherwise the property is documented only. A `signOut` of the current token
  committed after step 2 still gives this call its 200. The next request with that token gets
  401. This pins "excluded by this call", not "always live".
- **`ended` bounds.** It is always a non-negative safe integer.
- **Optional (A's S4).** A passkey step-up for the same person commits alongside a revoke. Both finish, with no
  deadlock.

**2. Web.** The server action, the control and the copy:
- a unit test for each result's wording, including "No other active sessions were ended.", refused, and unknown.
  Neither refused nor unknown contains "nothing" or "no change".
- Playwright with two contexts signed in as one synthetic person:
  - A confirms and stays signed in;
  - B's next navigation reaches sign-in;
  - Cancel sends nothing;
  - no token or hash appears in the HTML or the action response.

**3. Mobile.** The runner method and state, the path, the parse, the copy, the screen, and a harness browser check.
Runner tests:
- **ABA:** sign out and back in as the same person, then confirm the old control: `stale`, nothing sent.
- **Account change while in flight:** `stale`; no result shown; the 401 for the old handle is ignored, with no
  dispatch.
- **Unmount and remount while in flight:** the button is still disabled and `last` is shown on arrival; no second
  send.
- **Duplicate press:** exactly one send.
- **Wait bypass:** a 429 with `Retry-After`, then a remount, then a press before the wait ends: `waiting`, nothing
  sent. At the wait, the press sends.
- **401 on the current handle:** the session ends with the existing wording.
- **Waits are separate:** this wait never alters the `/v1/me` wait.
- **Malformed 200:** unknown. That includes an `ended` that is negative, fractional, above
  `Number.MAX_SAFE_INTEGER` or not a number.
- **Other 4xx:** `refused`, with its wording.
- **Rejecting client:** `client-bug` or `stale`, never a rejection.
- **No token** in any outcome, view or snapshot.

The harness browser check covers confirmation, in flight, N, 0 and unknown. No native, simulator or device evidence
is claimed.

**Ownership**
- B implements the API increment (1); A independently reviews it. Owners for the later web and mobile
  increments are assigned when those PRs start.
- Root owns tests, git, browser checks, docs and integration, including the already-authorised release to the single
  staging machine.
- This contract adds no deployment constraint.

## 5a. Clarifications (root review of revision 2)

### 1. The refused-revalidation event commits

- A failing step 2 must **not** throw inside the transaction. A throw rolls the event insert back.
- Follow the `nativeExchange` pattern (`auth/service.ts:150-174`):
  - the transaction callback records the failure event and **returns** `{ error: unauthorised() }`;
  - the transaction commits;
  - the method throws after `begin` returns.
- The success path returns `{ ended }` in the same way.
- **API test:** after a 401 from step 2, an `auth.sessions.revoke_others` row with `success = false` exists, and the
  sessions are unchanged.
- A 401 from the middleware (`requireSession`) records no event. That is the same as every other signed-in route.
- **The 401 is `unauthorised()`**, the same `HttpError` code and body shape that `requireSession` throws. So the
  web's `sessionFailure` and mobile's client both treat it as signed out.
- **API test:** exactly one row, with `success = false` and detail exactly `{reason: 'current_session_ended'}`. The
  response body equals a middleware 401's body.

### 2. Everything is global and per person

- **Data.** The service uses the plain `deps.db` (the `captain_runtime` connection), like the rest of
  `AuthService`.
  - It uses no organisation-scoped transaction helper.
  - It sets no `current_organisation_id()` context.
  - It reads no membership.
  - A person with any number of organisations, or none, gets the same result.
- **Rate limits.**
  - The path is `/v1/me/...`, so the `organisation`, `trigger` and `chatWrites` keys are null and don't apply.
  - The limits that apply:
    - the IP policy (300 a minute);
    - the per-person `user` policy (600 a minute);
    - the new per-person `sessionRevocations` (5 a minute, key `revoke:{userId}`).
  - The limiter is the existing in-process fixed window. One machine serves the environment, so the window is global
    for that machine.
- **Grants.** No change. `captain_runtime` already holds `app`'s direct `update` on `sessions` and `insert` on
  `auth_events` (`0001` and `0041`).
  - This route writes nothing tenant-scoped, and uses no function or table covered by tenant RLS.
  - The runtime-role safety check is unaffected.

### 3. Mobile person scope: what advances it and what doesn't

- `personScope(machine)` returns `{ epoch: 'a' + generations.account, userId }` when the state is `signed-in`, and
  `null` otherwise. It is frozen, and holds no token or handle.
- **It advances only with the account generation** (`contracts.ts:24`): sign-in, sign-out, session end and account
  switch.
- **It does not advance for:**
  - a foreground or `/v1/me` refresh, which advances only the membership generation;
  - an organisation switch or loss, which advances only the organisation generation. Revocation belongs to the person
    and the session, not the organisation, so a result stays valid across an organisation change.
- **Runner tests pin this:**
  - a refresh during an in-flight call still settles as `ok`;
  - an organisation switch during an in-flight call still settles as `ok`;
  - sign-out and back in as the same person gives `stale`.

### 4. Snapshot stability and notifications

- The revocation state lives in the runner, **outside** the reducer's `Machine`. So the runner's existing "notify
  only when the machine changes" rule (`runner.ts:100-103`) would not publish it.
- `revocationView()` returns one frozen object, replaced only when its content changes:
  - `in-flight` set or cleared;
  - `wait` recorded;
  - `last` set.

  For a changed or null scope it returns one shared frozen `idle` object. So repeated reads are `Object.is`-equal,
  which `useSyncExternalStore` requires.
- **Publishing.** Every change calls the existing listeners once, with the current (unchanged) account snapshot.
  - Account consumers read `snapshot()`, which is `Object.is`-equal, so they don't re-render.
  - The revocation control reads `revocationView()` through the same `subscribe`.
  - A machine change that alters the person scope already notifies.
  - No listener is called for a no-op, such as a duplicate press answered `in-flight`.
- **A wait's end is not an event.** The screen re-renders at the wait with the existing `useWaitWake` pattern, and the
  runner re-checks the clock on the press anyway.
- **Threading.** `revokeOthers` and `revocationView` are added to `AccountSource` (`account-source.ts`) and exposed by
  `useAccount`. They are token-free, like `read`. The harness scripted source implements both for the browser check.
- **Remount (A's R3).** The runner, and so `revocationView()`, belongs to the one process-wide instance
  (`instance.ts`). It is never reset by an `AccountStack` or screen remount. The [native navigation contract](expo-mobile-native-navigation-2026-09.md) treats
  such remounts as possible (its §3.0).
  - Only a change of person scope discards the state.
  - A process restart loses it, together with the in-memory token.
- **Runner tests:**
  - **Remount:** a remount with the account still ready and the same scope keeps `inFlight`, `wait` and `last`. A
    press in that state is still answered `in-flight` or `waiting`, with nothing sent.
  - `revocationView()` is identity-stable across unrelated machine changes;
  - exactly one notification per revocation change;
  - no notification for a rejected duplicate;
  - `idle` is identical across scopes.

## 6. Settled in review

- Keep `ended`: honest wording needs the count, and it is a count, not metadata.
- The limit is 5 a minute per person.
- No client is recorded or guessed.
- A single confirmation step is acceptable.
- Pending codes are left alone.
