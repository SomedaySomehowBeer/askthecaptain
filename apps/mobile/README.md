# Captain mobile shell

Expo SDK 57, React Native 0.86.3 and React 19.2.3. The existing Next.js app remains
the web product. The app supplies Work, Chat and Resources navigation and grouped
view lists. The [composition increment](../../docs/plans/expo-mobile-auth-composition-2026-09.md),
composes sign-in and adds the account screens:
- a welcome page for every state that is not signed in;
- the organisation chooser and switcher;
- Account, which the tabs and Account are guarded behind (verified identity and a chosen organisation).

It has no business reads, local business cache or write actions yet: the tabs say that
the app doesn't read that data yet. Nothing is installed or usable on a device, and
there is no simulator or device evidence.

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
  no sign-in and no native authentication. It must not contain the harness marker or
  any `harness/app` path.
- **Synthetic account harness** (`dist-harness`). It is a test-only web export selected
  only by `CAPTAIN_MOBILE_HARNESS=1` at build time, and `app.config.ts` refuses it for
  native builds. It renders the production account stack, screens and tabs over
  scripted, token-free account states, with no API, credentials or account data. It
  is never deployed, and it must contain the harness marker.

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
