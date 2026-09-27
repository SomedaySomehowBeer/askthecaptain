# Captain mobile shell

Expo SDK 57, React Native 0.86.3 and React 19.2.3. The existing Next.js app remains
the web product. The app supplies Work, Chat and Resources navigation and grouped
view lists. The [composition increment](../../docs/plans/expo-mobile-auth-composition-2026-09.md)
composes sign-in and adds the account screens:
- a welcome page for every state that is not signed in;
- the organisation chooser and switcher;
- Account, available alongside the tabs only after identity is verified and an organisation is chosen.

The [My work read](../../docs/plans/expo-mobile-my-work-read-2026-09.md) (M-read slice 1) is
implemented and independently reviewed, with local tests, exports and browser checks passing.
See the [validation record](../../docs/validation/mobile-my-work-read-2026-09-27/README.md).
- **What it shows:** Work → My work lists the person's open tasks in the chosen organisation,
  read-only, under the subtitle "Open tasks assigned to you". Page 0 loads on each mount, with
  explicit Refresh, More and Try again, up to 10 pages and 500 rows.
- **How it reads:** every read goes through the account runner's single scoped entry point, bound to
  a token-free read scope and epoch. A list is bound to the scope it first showed, so a change of
  person or organisation shows nothing and sends nothing until the tabs reset.
- **What it doesn't do:** Chat and Resources, other Work views, detail pages and all writes are not
  implemented. There is no local business cache.
- **Open limits:** `expo/fetch` reporting the query URL unchanged, and a real 403/404, are device
  gates. Nothing is installed or usable on a device, and there is no simulator or device evidence.

**The [response byte budget](../../docs/plans/expo-mobile-response-byte-budget-2026-09.md) is implemented and independently reviewed, with local checks passing.** The transport (`src/api/client.ts`) reads each response body as a byte stream:
- it keeps, decodes and parses at most 1 MiB of decoded bytes (a policy limit);
- it refuses an oversized declared `Content-Length` without touching the body;
- it stops at the first chunk that crosses the limit;
- it decodes UTF-8 strictly, so invalid bytes make the body unreadable;
- one 30-second timer covers the headers and body.

An unusable body keeps its status and `Retry-After`. It is never data, and never a client bug.

This bounds only what JavaScript keeps and parses. It is **not** a guarantee on total memory: native buffering before
streaming, one delivered chunk, and decoding and parsing overhead are not bounded. Whether cancelling actually stops the
native download is a device gate with no evidence yet. See the [validation record](../../docs/validation/mobile-response-byte-budget-2026-09-27/README.md).

The source contract is [the mobile foundation plan](../../docs/plans/expo-mobile-foundation-2026-09.md).
Tokens cite the reviewed mockups in `src/theme/tokens.ts`; system fonts are used.
The development scheme and bundle identifiers are unsigned placeholders, not
registered release identities. Native sign-in remains disabled on shared staging
and for real accounts pending the verified app-link identity gate.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/mobile exec expo install --check
pnpm --dir apps/mobile check
pnpm --dir apps/mobile test
pnpm --dir apps/mobile start
```

On the shared development machine, use `flock /tmp/atc-build.lock` around each
install, build or test. `.github/workflows/mobile.yml` runs the source/dependency
boundary guard, tests, SDK check, four exports, exported-secret checks and harness-exclusion checks.

Two web exports are built and checked separately:
- **Production web export** (`dist/web`, `CAPTAIN_MOBILE_HARNESS` unset). It is web-only:
  no sign-in, no native authentication, and no requests (it never becomes ready, so My
  work never reads). It must not contain the harness marker or any `harness/app` path.
- **Synthetic account harness** (`dist-harness`). It is a test-only web export selected
  only by `CAPTAIN_MOBILE_HARNESS=1` at build time, and `app.config.ts` refuses it for
  native builds. It renders the production account stack, screens and tabs over
  scripted, token-free account states, with no API, credentials or account data.
  My work's reads stay pending until a harness control resolves them with synthetic
  fixtures through the real parser (`work-read-log`, `work-read-pending`,
  `harness-read-{control}`). It is never deployed, and it must contain the harness marker.

A browser approximation runs both exports at 360, 390 and 430 pixels. After editing
anything under `src/auth`, `src/account` or `src/platform`, fully reload the app
before testing sign-in: Fast Refresh keeps the account instance built from the old code.
Only the two named public URLs are allowed as app environment reads. Server
workspace packages are forbidden. This guard is a review aid, not a JavaScript
security sandbox; its source scanner and bundle check complement code review.

The dependency lock keeps mobile and Next.js React separate. Revisit the four
SDK peer overrides in `pnpm-workspace.yaml` on every SDK upgrade. Transitive native
modules may be autolinked despite not being imported by the app; inspect that list
before a development build. Do not add a direct gesture/animation dependency for
the shell.

Exports are JavaScript/Hermes bundles, not signed native builds. Android config
introspection confirms `allowBackup=false` and both SecureStore backup-rule
references; native compilation and device backup behaviour remain unverified.
Still required: cold-launch and warm-link behaviour, independent tab stacks,
native back gestures, safe areas, larger text (tab labels currently cap scaling
at 1.4), VoiceOver/TalkBack, keyboard behaviour and performance on devices.
Sign-in on a device, SecureStore behaviour and claimed HTTPS app links still need device
evidence. An exact sign-in callback delivered as a system link does not navigate: only the
pending authentication session reads it. Every other `/auth/*` link and every lookalike is
refused.

The web-export check uses browser history for every visited route; native stacks
place the grouped view list beneath the selected page. Browser checks therefore
do not prove that native stack arrangement or its swipe-back gesture.
