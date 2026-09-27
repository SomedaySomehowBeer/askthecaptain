# Captain mobile shell

Expo SDK 57, React Native 0.86.3 and React 19.2.3. The existing Next.js app remains
the web product. This increment supplies Work, Chat and Resources navigation,
grouped view lists, account access and honest signed-out screens. It has no sign-in,
business reads, local business cache or write actions yet.

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
boundary guard, tests, SDK check, three exports and exported-secret checks. It also
runs a browser approximation of the exported shell at 360, 390 and 430 pixels.
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
Authentication, SecureStore behaviour and claimed HTTPS app links follow in
separate increments. Every incoming sign-in callback is refused by this shell.

The web-export check uses browser history for every visited route; native stacks
place the grouped view list beneath the selected page. Browser checks therefore
do not prove that native stack arrangement or its swipe-back gesture.
