# R2a screen 2 — members and invitations (30 September 2026)

Outcome: **manage shared work** — owners and admins manage organisation access from the
one Expo client (D37). Second of three slices for [#221](https://github.com/SomedaySomehowBeer/askthecaptain/issues/221),
based on main `a1df84f` after the passkeys PR #223. Push devices remain the third slice.

## Behaviour

Members opens from Settings at `/members` and uses the existing account layout and mobile
theme tokens. It lists member roles and pending invitations. Owners/admins create an invitation
for an email address and member/admin role; the API's one-time token becomes a same-origin
acceptance link for the person to copy and share. No email is sent. Links remain in screen
memory only, clear on leaving/changing scope or another mutation, and are never stored in
localStorage/sessionStorage. Clipboard copying is explicit and has a selectable-link fallback.

The controls mirror known API rules: admins cannot change/remove owners or grant ownership;
the last owner cannot be demoted or removed. Server refusals remain authoritative, including
`last_owner`, `membership_changed`, `already_member`, missing records and permission changes.
Ordinary members cannot open the management UI or issue its reads. Native clients show an
explicit browser-availability notice; this slice enables no native business writes.

All calls bind person, organisation, epoch and role before sending and again before consuming
an answer. Late results are discarded after a switch or loss. Self-role/removal requests refresh
memberships. Reads must succeed before writes are enabled; one request sequence runs at a time.
Unknown writes are never retried automatically: refresh first. A lost invitation token cannot be
retrieved; creating a replacement invitation revokes the previous pending invitation for that email.
Retry-After disables requests until its deadline.

The client reuses the existing role-checked, transactionally audited access APIs. No schema,
package or dependency is added. This is access management, not a record-version/undo interface.
A new role change or invitation is an explicit new write; removing a member also ends their chat
participation, which this UI does not claim to undo or restore.

## Checks

All heavy commands used `flock /tmp/atc-build.lock`.

- Frozen offline install, mobile typecheck/source guard and API typecheck: passed.
- `pnpm --dir apps/mobile test`: **371 pure tests + 20 boundary/config tests passed**, zero skips.
- Expo SDK compatibility and generated Android backup-configuration checks: passed.
- Fresh production web, iOS and Android JavaScript exports and separate web harness: passed.
- Source/bundle boundary, secret-canary and production/harness separation scans: passed.
- Cookie-session and app API suites against disposable real Postgres databases: **17 passed**,
  zero skips. Includes invitation acceptance/revocation, member lists/role changes/removal,
  owner/admin and last-owner restrictions, CSRF requirements and cross-tenant refusals.
  See [members-postgres.log](members-postgres.log).
- Browser: members and invitation flows plus harness states at **360/390/430/1280 px**;
  existing shell checks at all four widths and passkey, revocation and equipment regressions
  at phone widths. No page errors, external requests or overflow. See [members-browser.log](members-browser.log).
- `git diff --check`: passed.

Pure tests additionally cover strict bounded response parsing, current/stale 401s, a person or
organisation changing during a request, controller disposal, concurrent submissions, server
refusals, unknown writes and Retry-After. Browser tests use the actual cookie client and include
leaving during a pending invitation write, switching organisation and discarding the old link.

Synthetic screenshots: [owner controls, 360 px](members-owner-360.png),
[invitation link and copy fallback, 390 px](members-invitation-390.png),
[failed list, 430 px](members-failed-430.png).

## Limits

Browser checks use synthetic API answers, synthetic people and a stubbed clipboard adapter.
Real-Postgres tests separately exercise the actual routes and non-bypassing runtime role. This
is not a hosted browser/API round trip. No hosted evidence until root deploys and validates it.
No external invitation email, real-user change, deployment, DNS, production or secret operation.
No native build/device, assistive-technology or cross-browser claim; platform exports are
JavaScript bundling evidence only. Push device controls remain outstanding.
