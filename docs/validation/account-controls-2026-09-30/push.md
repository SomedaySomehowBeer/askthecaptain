# R2a screen 3 — push devices (1 October 2026)

Outcome: **manage shared work** — people manage how Captain reaches their devices from the
one Expo client (D37). Third screen for [#221](https://github.com/SomedaySomehowBeer/askthecaptain/issues/221),
based on `2918ba0` after members #225. No deployment.

Settings → Notifications uses `/settings/notifications`, retaining the destination of the
existing test notification. Any member can manage only their own devices in the selected
organisation. The screen lists devices, registers this browser using the API's VAPID public key,
removes a device and sends the existing fixed test. It shows the exact test title and body before
the send button; no test is automatic. Delivery results distinguish provider acceptance, failure
and expired subscriptions; acceptance never claims that a notification appeared.

Browser registration happens only on a click. Permission denial, insecure context, unsupported
browser, unconfigured server, empty list, failed read and pending actions have explicit states.
Native shows an unavailable notice. Calls bind person, organisation and epoch before sending
and consuming answers. Leaving during permission/worker setup prevents the subsequent API write.
Only one operation runs at a time; an unknown write requires a successful refresh, honours
Retry-After and is never retried automatically. Keys stay inside the registration call; device
endpoints stay in screen memory and never become UI links or page-storage values.

Removal disables only this person's subscription in this organisation, using the existing API.
It does not unsubscribe the origin-wide browser PushManager subscription, which could serve
other organisations. Existing device access writes are audited; these personal notification
settings are not business-record versions. Registration is an explicit new write after removal;
there is no snapshot undo. A sent test cannot be recalled.

The notification-only worker caches nothing, bounds payload text and refuses cross-origin or
API/auth notification destinations. The single-page export's public HTML template links the
manifest, which references Captain's existing owned icon. No package or dependency added.

## Checks

Heavy commands used `flock /tmp/atc-build.lock`; export/browser chains waited for more than
1500 MB available memory.

- Mobile/API typechecks, frozen installation and source guard: passed.
- Mobile: **382 pure tests + 20 boundary/config tests**, no skips.
- SDK compatibility and Android backup configuration: passed.
- Fresh web/iOS/Android and harness exports, source/bundle boundary and secret-canary scans: passed.
- Real disposable Postgres push and cookie-session suites: **13 passed**, zero skipped.
  See [push-postgres.log](push-postgres.log). Cookie coverage includes CSRF, cross-tenant reads,
  same-organisation person isolation, registration, test and removal.
- Browser: push controls and harness states at **360/390/430 px**; existing shell/members at
  **360/390/430/1280 px**, plus phone passkey/session/equipment regressions: passed. No page
  errors, external requests or horizontal overflow. See [push-browser.log](push-browser.log).
- `git diff --check`: passed.

Pure tests cover stale responses/401s, leaving during permission, overlapping requests,
unknown-send pacing, strict payload parsing, DELETE request bodies and worker payload/navigation.

Screenshots: [registered, 360 px](push-registered-360.png), [failed read, 390 px](push-failed-390.png).

## Not covered

Browser permissions, PushManager subscription and API deliveries use synthetic adapters. This
is not proof of OS notification appearance, provider delivery, installed PWA behaviour, hosted
end-to-end API operation, native push, native builds/devices, assistive technology or other browsers.
No real account/device was changed, external test sent, secret changed, deployment or DNS performed.
Hosted permission/subscription/delivery acceptance remains for the owner after deployment.
