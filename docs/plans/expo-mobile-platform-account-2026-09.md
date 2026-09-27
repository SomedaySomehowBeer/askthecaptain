# Mobile platform adapters and account state

Status: implemented and reciprocally reviewed; integration pending, 27 September 2026.
Continues the adopted [foundation](expo-mobile-foundation-2026-09.md) after merged
shell #188 and pure authentication core #189. Outcomes: manage shared work,
allocate resources and discuss work through the same authenticated API.

This increment supplies injected, tested platform adapters and an account reducer
and effect runner. It adds no screens, provider binding, business reads beyond
identity/memberships, remote session controls, app links or native enablement.
Nothing is wired into the app yet: no screen, provider or bootstrap calls the adapters
or the runner, and no request is made at import.

| Owner | Scope |
|---|---|
| Claude business-views | All src/platform adapters, including secure-storage.ts; installed-SDK bindings, API transport injection rename and boundary guard/tests |
| Claude linked-chat | Account state/reducer, private credential-owning runner, strict identity/membership parsing and controlled-completion tests |
| Codex | Dependency lock, source verification, integration, evidence, documentation and release sequencing |

The agents review each other's plans and final code. No agent runs builds, tests
or git; Codex runs applicable checks serially under the shared build lock.

## Platform contract

- Installed SDK 57.0.25 names expo-crypto and expo-web-browser ~57.0.3; both were
  already authorised by the foundation. The lock resolves both to 57.0.3.
- Use asynchronous native random bytes (no development Math.random fallback) and
  raw-byte SHA-256. Guard against synchronous getRandomBytes. Check the RFC 7636 vector through the injected crypto adapter.
- Use the system authentication browser with the exact pending callback contract.
  Cancellation still holds the start gate until the prior platform operation settles.
  Android also delivers the callback to the router and may cancel on app foregrounding;
  router presentation belongs to the screen increment and remains a device check.
- Only the transport adapter imports expo/fetch. Force redirect:error and
  credentials:omit; all API destinations still pass through the fixed-origin core.
  Global React Native fetch does not enforce redirect rejection. Root verified
  Expo's iOS refusal callback and Android followRedirects(false) source; these
  source checks do not replace signed-app/device redirect tests, including encoded paths.
- SecureStore is the only storage mechanism. Use consistent options and
  WHEN_UNLOCKED_THIS_DEVICE_ONLY from the first credential write. Delete then
  read back; an error or a remaining value is an uncertain deletion.
- SecureStore null means no usable saved sign-in was returned, not proof of no
  stored bytes. Unsupported storage and web refuse native sign-in before access.
  Reinstall on iOS may retain a keychain session; the API verifies it at launch.
- The lexical boundary guard permits native network binding only in its adapter.
  Rename the injected transport function to avoid falsely treating it as global fetch.
  Guard tests document the scanner's limits; it is not a security sandbox.

## Account contract

- Only the runner owns tokens. Reducer state/events/effects use opaque handles.
  One global gate requires no live runner handle, no cleanup pending, idle auth
  attempts and settled prior storage before starting another sign-in.
- Every save/removal is keyed to its handle. A failed save can have written:
  compare-delete it and revoke it. Hold credentials until each obligation has an
  honest outcome. Duplicate completion never repeats revocation; deliberate retry
  can retry unresolved local removal and server cleanup while respecting Retry-After.
- Ten-second notices do not cancel physical operations or allow replacement.
  Never infer server expiry/revocation from the adjustable device clock.
- A saved session first shows checking. Unavailable identity verification permits
  retry/sign-out, never confirmed signed-in state or business data. Retry honours
  the identity response's Retry-After as well as cleanup backoff. Apply a return
  destination only after verified identity and current membership.
- Retain the person's organisation choice across sign-out as a hint. Revalidate
  membership before use. Handle, account, organisation and membership generations reject stale results.
  An item 403/404 triggers membership revalidation; only the fresh membership list
  establishes lost organisation access. Missing items and role restrictions do not.
- Without a stored choice that is still a membership, a validated membership list with
  exactly one organisation selects it and saves it as the hint; an empty list selects
  none; several ask the person. A choice is only ever taken from the latest applied list.
  A stored choice that is no longer a membership is forgotten. A `/v1/me` response naming
  a different user from the saved session fails closed as “session ended”.
- The runner exposes one organisation-read mechanism (`organisationRead`). It sends only
  with verified identity and a chosen organisation, using the current credential, which
  never leaves the runner. A 401 ends that session; a 403/404 only requests a fresh
  membership list. Each answer is tied to the handle and organisation generation it was
  sent under and is reported as superseded if either changed. This increment adds the
  mechanism only: no screen or business read calls it yet.
- A second or unclaimed credential is a fault, never dropped: it is released like any
  other (compare-delete and revocation), shown without its token, and keeps sign-in
  blocked until both obligations have results. The runner's single cleanup slot credits a
  retry only to the handle it holds. A revocation that cannot begin because the slot holds
  another session is refused: the handle is kept, and only a deliberate Try again made
  once the slot is free begins it. Missing prerequisites report a fault with a bounded,
  honest result rather than leaving a state waiting silently.
- Sign-out reports local and server outcomes separately. If a copy may remain and
  revocation is pending, closing the app may leave the person signed in next launch;
  say so. No new persistent sign-out marker is added in this increment.
- Unreadable storage offers retry-reading first. A deliberate new sign-in may
  replace unreadable credentials; remote revocation remains a separate readiness gate.

Pure tests cover adapter options/failures, cryptographic encoding, secret-free state,
stale membership/401 responses, delayed and partial storage, duplicate completion,
uncertain sign-out/retry and the global gate. Bundle exports, native builds and
real-device evidence stay distinct. Native sign-in stays off on shared staging and
for real accounts; no deployment, schema, data, signing or DNS change is included.

## Implemented

- `apps/mobile/src/platform/`: `auth-platform.ts` (crypto with the RFC 7636 known-answer
  check, and the authentication browser; native only), `native-send.ts` (forced
  `redirect: 'error'` and `credentials: 'omit'`), `fetch.ts` (the only `expo/fetch` import),
  `secure-storage.ts` (consistent options, delete then read back, web and unavailable
  storage refused) and `expo.ts` (installed-module bindings), each with injected-module tests.
- `apps/mobile/src/api/client.ts`: the injected transport function is `send`.
- `apps/mobile/scripts/check-boundary.mjs`: the network and synchronous-random rules.
- `apps/mobile/src/account/`: `machine.ts` (reducer), `runner.ts` (credential-owning runner)
  and `me.ts` (strict `/v1/me` parsing), with controlled-completion tests.

Validation: the mobile typecheck and boundary check pass, with 110 pure mobile tests and 16
client-boundary tests. None of this is simulator, native-build or device evidence.

## Required in the next slice

- Composition: the runner gets its own `createCleanup` instance, separate from the attempt
  core's, and the wiring asserts they differ. `nativeSend`, the authentication platform
  and device storage are bound there, never earlier. Await the asynchronous
  `openSecureStorage` first; pass `createStore: null` when storage is unavailable.
- Provider and screens present every account state honestly, including `closing`,
  `unverified`, releasing notices with the close-app warning, strays and faults.
- Android delivers the callback to the router as well: `+native-intent` must leave
  navigation unchanged for the exact callback without accepting it as a route.
- Business reads use only `organisationRead`.
- The device gates remain: redirect refusal including an encoded organisation path,
  crypto, the authentication browser on both platforms and SecureStore behaviour.
  Native sign-in stays off until they and the link-identity gate pass.
