# Staging assistant retirement release — 27 September 2026

Outcome: keep Captain focused on shared business work by removing obsolete assistant code and mailbox grant management. This deploys the reviewed main tree through [#191](https://github.com/SomedaySomehowBeer/askthecaptain/pull/191), including R1–R5a and the default-off server/web native handoff. It does not complete R5b, Pip or mobile readiness. The tree also contains mobile shell/core source; no mobile app was installed or released.

Source `17089ce409c73eb6cf758113472f704dad359d9a` and squash merge `02458b7e3fa0c18ce8a57087486180a870a8ab0e` have the same tree. [CI 36297908439](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36297908439) passed both check and chat-browser. Both Claude Opus agents reviewed the implementation and root's release checks. R4b local evidence included 505 uncached Postgres tests, workspace typecheck, a production web build, and Connections/deletion browser checks at 390/1280 pixels. R5a separately passed 207 API tests. Those earlier runs are supplemented by the final rebased CI, not claimed as local tests of a different head.

## Images and fleet

The clean-source Docker builds and pushes matched their OCI index digests. Fly resolved each index to its platform manifest:

| App / existing machine | Deployed platform digest |
|---|---|
| API staging `80e39ea6416e18` | `sha256:9888f1a419eff548fd1569c30c373e4d14ec9c6ff6779fe0b70677f632e71e2f` |
| Web staging `9185776e7cd3d8` | `sha256:830e0192fbaf93f3b9c439eeb9f8d9522cd2b460f9d78ba8abd7465479df231e` |

Both images use `registry.fly.io/askthecaptain-{api,web}-staging:git-17089ce`. API index: `sha256:936d6cff3af36484f2a3766a3170b3e1f5ca40f79f3662292281c17715836c8c`; web index: `sha256:55259424a064e811692406530c9680597bff8da34b00c998599fc3ecb8ba9b0b`.

Exactly one existing machine per staging app. The web is idle-stopped in the fleet snapshot under its normal auto-stop setting; the later browser check confirms it starts and serves sign-in. Final configuration changes are image-only. Production's four machines and the embedding machine remain stopped with unchanged configuration and identities. No DNS, credentials, provider revocations or infrastructure changes. Automatic deploy and backup workflows remain disabled.

## Migration and verification

Verified-TLS owner preflight used a read-only transaction with `row_security=off` (filtered counts fail). Google connections: zero; attachment text: zero. Exactly 0044 was pending, its existing check constraint was present, and both grant-target roles existed.

The sole API ran a one-shot with no public services and restart policy `no`. Migration `0044_native_handoff.sql` applied at **06:02:01 UTC**, the queue completion marker appeared at **06:02:02**, and the guest exited normally with code **0**. The fresh Fly exit event was at **06:02:06.119**. The image, unique applied migration, marker, guest exit and event were checked together. No external stop or OOM was reported. Fly omitted the zero-valued exit-code field, so the timestamped guest exit log provided explicit exit-code proof.

Normal API configuration was restored and compared before explicit start. Read-only postflight confirmed all 41 expected migrations, all eight auth-request kinds and the three required workflow queues. The deployed `requireSafeRuntimeRole` passed, including privileged-role membership and ownership checks; the runtime is `captain_runtime`.

`/readyz` returned 200. The live `/auth/google/start?client=native` returned 400 `native_sign_in_unavailable`: native sign-in remains disabled. Web was updated after API verification. An isolated anonymous session in the shared Chrome loaded `/sign-in` at 390 pixels with a visible Google sign-in button and no page errors; root visually checked the screenshot. This is public sign-in smoke evidence, not an authenticated end-to-end acceptance test.

## Next gate and rollback

The reader-free API image above is the minimum rollback baseline for the future R5b schema deletion. **R5b has not run.** It requires a new count-only audit of every listed legacy table and retained nullable reference, a reviewed guarded migration, and its full database tests. Do not repeat the old staging reset or delete current demo, Work or Chat records.

0044 is additive; retain it on rollback. Before R5b, the prior API can still run with 0044. After R5b, never restore an image that contains retired table readers or recreate dropped tables. Production remains paused and cannot be resumed on its old image.

The JSON files here contain only CI/tree metadata, count/schema/role results, migration proof and fleet identity/configuration differences. They contain no credentials, email bodies or customer record content.
