# Captain mobile shell

Expo SDK 57, React Native 0.86.3 and React 19.2.3. The existing Next.js app remains
the web product. The app supplies Work, Chat and Resources navigation and grouped
view lists. The [composition increment](../../docs/plans/expo-mobile-auth-composition-2026-09.md)
composes sign-in and adds the account screens:
- a welcome page for every state that is not signed in;
- the organisation chooser and switcher;
- Account, available alongside the tabs only after identity is verified and an organisation is chosen.

The [My work read](../../docs/plans/expo-mobile-my-work-read-2026-09.md) (M-read slice 1) is
merged in #199 after independent review and passing local tests, exports, browser checks and CI.
See the validation record (validation record removed in the chat-first rebuild; see git history).
- **What it shows:** Work → My work lists the person's open tasks in the chosen organisation,
  read-only, under the subtitle "Open tasks assigned to you". Page 0 loads on each mount, with
  explicit Refresh, More and Try again, up to 10 pages and 500 rows.
- **How it reads:** every read goes through the account runner's single scoped entry point, bound to
  a token-free read scope and epoch. A list is bound to the scope it first showed, so a change of
  person or organisation shows nothing and sends nothing until the tabs reset.
- **What it doesn't do:** Chat and other Resources views (except Inventory, below), other Work views (except All tasks), detail
  pages and all business writes are not implemented. There is no local business cache.

The [All tasks read](../../docs/plans/expo-mobile-all-tasks-read-2026-09.md) (M-read slice 2) is
merged in #201 after independent review and passing local tests, exports, browser checks and CI.
See the validation record (validation record removed in the chat-first rebuild; see git history).
No native or device result is claimed.
- **What it shows:** Work → Views → All tasks (`/work/all`) lists the open tasks the Work API returns
  for the chosen organisation, assigned to anyone, read-only, under the subtitle "Open tasks assigned
  to anyone".
  - It is open tasks only: In progress, Suggested and Done are not included.
  - Each row shows one owner fact, "Assigned to you", "Assigned to someone else" or "No owner", and no
    names.
- **How it works:** it uses the same shared screen, list rules and scope binding as My work, with the
  view fixed when the screen mounts. Each mounted list keeps its own rows, and every new mount reads
  page 0. No list is cached across views.
- **Open limits:** `expo/fetch` reporting the query URL unchanged, and a real 403/404, are device gates. Nothing is installed or usable on a device,
  and there is no simulator or device evidence.

The [Inventory read](../../docs/plans/expo-mobile-inventory-read-2026-09.md) (M-read slice 3) is
implemented and independently reviewed; final validation is recorded in the
evidence (validation record removed in the chat-first rebuild; see git history).
- Resources → Inventory shows active counted stock grouped by location, with exact decimal strings,
  stored units, uncounted states, reorder points and the server's below-reorder flag.
- The API returns one unpaginated list, subject to the mobile response byte budget. One virtualised
  SectionList contains the heading, controls, groups and footer; it is never nested in a ScrollView.
- Reads are bound to the person/organisation scope. Refresh and retry are explicit, waits are respected,
  a failed refresh retains labelled older rows, and a changed scope immediately hides them.
- The fixed website link appears after a successful load, including an empty list. There are no count,
  edit, add or archive controls. No business writes, installed-app proof or native enablement is added.

**The [response byte budget](../../docs/plans/expo-mobile-response-byte-budget-2026-09.md) merged in #202 after independent review and passing local checks and CI.** The transport (`src/api/client.ts`) reads each response body as a byte stream:
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
  My work, All tasks and Inventory reads stay pending until a harness control resolves them with
  synthetic fixtures through the real parser (`work-read-log`, `work-read-pending`,
  `harness-read-{control}`). The fixtures' view and owners come from the requested path's
  query; stock fixtures use the exact stock path and include uncounted, unusual-decimal and malformed answers. Account revocation uses `account-revoke-log`, `account-revoke-pending` and
  `harness-revoke-{control}` for controlled pending replies. It is never deployed, and it must
  contain the harness marker.

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

The web-export check uses browser history for every visited route. Native navigation merged in
#205: explicit section initial routes, anchored app entries and fresh `[views, index]` Work resets
place the view list beneath the target by source inspection. The
[navigation contract](../../docs/plans/expo-mobile-native-navigation-2026-09.md) records two existing
limitations: a warm view-list link can add a duplicate view list, and a ready remount on the
organisation page can add a second tabs route. Browser checks prove neither native stack
arrangement nor swipe-back gestures; both remain device checks.

The Account screen now implements **Sign out everywhere else** under the
[session revocation contract](../../docs/plans/mobile-session-revocation-2026-09.md). State belongs
to the person and account generation, survives screen remounts, and is discarded on sign-out or
account change. No business writes or native enablement accompany this account control. See
[the validation record](../../docs/validation/session-revocation-mobile-2026-09-27/README.md) for
passed checks and remaining gates.
