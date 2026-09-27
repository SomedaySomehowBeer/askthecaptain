# Session revocation API — 27 September 2026

Outcome: manage shared work through secure account access, under [increment 1 of the contract](../../plans/mobile-session-revocation-2026-09.md).

`POST /v1/me/sessions/revoke-others` ends the authenticated person's other existing sessions. The
body supplies no identity or session selection. The calling session is rechecked after a per-person
lock; expiry and the count use statement time. The same transaction records success or the refused
recheck. A refusal's audit event commits before the service throws the standard 401. Only a count
is returned. Five calls per person per minute apply to this exact endpoint.

Pending sign-ins and sessions committed after the revoking statement's snapshot can survive.
Retries apply to sessions visible to that new call. This is not an account lockout. No schema,
grants, dependencies, inferred device metadata, web controls or mobile controls were added.

Claude B implemented this increment; Claude A independently approved it. Root's first typecheck
found a tuple inference error in a new rate-limit test; `as const` fixes the test's type without
changing runtime behaviour. Both agents reviewed that repair.

- Workspace typecheck: 10 tasks passed, 9 unchanged cached.
- API suite on disposable real Postgres databases as `captain_runtime`: 219 tests passed, zero skipped.
- CI: both workspace/database and Chat browser jobs passed on source `41555d6`; merged as #204.

The new tests cover cross-person isolation, unchanged current session, expired/revoked rows,
ignored spoofed body, audit detail, token/hash absence, repeated calls, expiry while queued,
concurrent callers, snapshot cutoff and rate limits. Lock tests observe actual `pg_locks` waits.
Optional passkey-step-up concurrency and current-session sign-out after recheck are not simulated;
no production ordering hook was added solely for those optional tests.

No web page changed, so no additional local browser check. No deployment is claimed by this
record. Native sign-in remains off; web/mobile controls and device acceptance remain separate work.
