# Session controls released to staging — 27 September 2026

Outcome: manage shared work through secure account access. Reviewed API #204 and web #206 are
released on the two existing staging machines. **Settings → Sign out everywhere else** keeps the
current session and ends the person's other existing sessions. Sign-ins in progress and new
sign-ins can still create sessions; already displayed content remains until its next server check.

## Source and validation

- Clean detached source: `b484e30b854570c588b4a51eff633dc1294f1614`; tree `3926256f38558518f116e856a7bea7f13716b42e`. This is the #206 merge commit.
- Both Claude Opus agents independently reviewed the source and browser evidence. Claude A also
  reviewed the concrete release script and the Depot fallback; review findings were resolved.
- #204 [CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36311112951) and #206
  [final CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36313202687) passed.
  The final web repair made an older Chat sign-out selector exact; its full affected suite passed locally.
- Combined main CI at #207 also [passed](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36313725468),
  with [mobile CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36313725458) passing separately.
  #207 changes no server-image input.
- Local API validation: 219 real-Postgres tests, zero skipped. Web: 141 tests, typecheck,
  production build and two-session real API/Postgres browser proof. See the separate source evidence records.

## Images and operations

| Existing staging machine | Installed single manifest |
|---|---|
| API `80e39ea6416e18` | `registry.fly.io/askthecaptain-api-staging:git-b484e30@sha256:573eda740bf59c527aece247090542c8178548f9ba106e1d0d2a545d7431f9cd` |
| Web `9185776e7cd3d8` | `registry.fly.io/askthecaptain-web-staging:git-b484e30@sha256:83b34bfab6aa346ea26466ee5b57072cb73406cfaabbfd5c5bba62178bde2314` |

Both local Docker builds passed, but two API push attempts through the local daemon timed out at
the Fly registry. No machine had changed. The fallback used Depot with explicit root build context,
Dockerfile, **build-only** and **push** flags. Each exported a single manifest and successfully
pushed that exact digest. These are the Depot images, not the different unpublished local digests.
Corepack resolved pnpm 10.34.5 in the builds. Temporary Docker registry credentials were removed.

The API was updated first, then the web after API postflight passed. Each update changed only
`config.image` on the existing machine. Full fleet comparisons preserved every other configuration
field and all machine IDs. No temporary release or Fly builder machine was requested; Depot built
the images externally. Exactly one machine remains in each staging app. Production's four machines
and the embedding machine remain stopped, with their configuration unchanged. Deploy, backup and
credential-operation workflows remain disabled.

No migration or queue installer ran: the diff from deployed API source `02733f2` to release source
is empty for `packages/db/migrations` and `packages/engine`. Applied schema 0045 remains. API runtime
changes since that image are #204 session revocation only. The web's shared packages also include
#194's already-applied legacy schema cleanup, plus #206's new Settings control. No data reset,
credential, DNS, signing or native enablement change occurred.

## Postflight

- [Read-only API proof](api-postflight.json): readiness 200; compiled deployed app contains the new
  route; imported runtime guard passes; current/session role are `captain_runtime`; transaction is
  read-only; native sign-in remains unavailable (400).
- Anonymous revocation POST returns 401. This proves authentication is enforced; **401 alone does
  not establish route presence**. The compiled-source check and observed image provide that evidence.
- [Hosted browser proof](browser-proof.json): clean anonymous Chrome at 390/1440 px, Settings returns
  to sign-in with `/settings` preserved; Google link visible, no overflow or page errors.
  [390 px screenshot](390-sign-in.png).
- No hosted authenticated revocation was run, so no real person's sessions were ended for testing.
  Authenticated two-session behaviour is local/CI evidence. No hosted multi-user capacity is claimed.
- Mobile #207 is merged source with exports/browser proof; it is not installed, enabled or deployed
  to a device. Native signing, claimed links, simulator and device acceptance remain open.

## Rollback

Restore only the affected images on these same machines, web before API if both need rollback:
- API: `registry.fly.io/askthecaptain-api-staging:git-02733f2@sha256:1e2cdf9407cda83b3363d5fa763812cedc72114955b255c8a5b15d55057be3aa`.
- Web: `registry.fly.io/askthecaptain-web-staging:git-17089ce@sha256:830e0192fbaf93f3b9c439eeb9f8d9522cd2b460f9d78ba8abd7465479df231e`.

Keep the restricted runtime role and schema 0045. No rollback was needed. The older API with new
web yields a refused result for the unsupported call; the new API with older web leaves it unused.
