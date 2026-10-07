# Captain Expo client

R1b replaces the three-tab client with the chat-first shell proposed in
[plan PR #214](https://github.com/SomedaySomehowBeer/askthecaptain/pull/214). It depends on the API's
cookie-session and static-export support in R1a (#217). Production and staging deployment
remain separate R1c work.

The root opens Threads with six fixed filters, grouped cursor pages, a read-only Equipment
schedule link and an unavailable Team row. Thread screens show the fixed record card,
oldest-first messages, first unread, pending-send recovery, message actions, pins and stars.
New thread opens a focused first-message composer; Private adds a title and member picker.
Uncertain creates preserve their IDs and selections for explicit retry. The card fold-out supports
revision-checked tag attachment/removal. R3 V-D adds change lines (kind `change`, parsed strictly and worded by code in
`src/threads/wording.ts`) and card editing in `src/threads/cards/`: a task's title, status, owner, due and steps, a
booking's title and time and its cancellation, and a stock count, each a revision-checked write with a client change
set id and the composer's uncertain-write rules ([V-D record](../../docs/validation/versions-2026-10-02/v-d.md)). R3 V-E adds History at `/threads/[id]/history` (`src/threads/history/`): a record's change sets newest first,
each change worded by the same code as its change line, with its state (tickable, changed since, undone, can't undo and why);
paging by cursor and where history starts, with the record as it was then; ticking, the preview sheet (now and after, conflicts
and coupled groups explained, blocked reasons in words), one apply per intent with a client id kept for an explicit retry, the
`409 stale_preview` fresh preview, and the applied state. It opens from the thread header's clock, the card's History link and
any change line. A topic's card offers "Make this a task" ([V-E record](../../docs/validation/versions-2026-10-02/v-e.md)).
Only an uncertain undo's id, change ids and basis are kept in session storage, per person and organisation. Files and People remain unavailable. Thread responses currently follow the R2 contract using
strict client parsers; a real-Postgres API test checks them against the merged T-A payloads. Account provides organisation switching, sign out, sign out everywhere else,
and web passkey listing, naming at registration, and removal. The invitation page accepts an invitation once and reports an
uncertain response without replaying the write. Owners and admins can open Members from Settings to create and revoke invitation links, change roles and remove members. These controls currently use the web cookie session; native shows an unavailable notice. Notifications in Settings lists and removes personal devices, registers this browser and sends the displayed test notification. Native push and organisation export/deletion controls are later work.

## Sessions

On web, the API serves `dist/web` and owns the HttpOnly session cookie. The source in
`src/account/web-session.ts` checks `/v1/me`, remembers only the chosen organisation ID under
the person's ID in localStorage, and exposes token-free account snapshots to screens. All API
requests use the page origin, include cookies and `x-captain-client: web`, drop Authorization,
and refuse redirects. Identity checks respect the 30-second spacing and Retry-After. A failed
initial check keeps the requested route; a failed refresh keeps the last verified workspace
and shows a connection notice. Confirmed 401 responses end the session.

Web passkey step-up uses `@simplewebauthn/browser` and the API's step-up cookie. A verified web
response reloads the safe return path. A native step-up retains the fixed one-time PKCE handoff;
native sign-in remains disabled. The native source, SecureStore and auth-session protocol are
retained, with no browser token stored in them. Fully reload after account/platform edits:
Fast Refresh can retain the previous account instance.

The [R1b validation record](../../docs/validation/expo-web-shell-2026-09-30/README.md) contains
the local shell results and synthetic screenshots. The [R2a passkey record](../../docs/validation/account-controls-2026-09-30/README.md) covers registration and removal.

## Local checks

Run heavy commands under `flock /tmp/atc-build.lock` on a shared machine:

```sh
pnpm --filter @captain/mobile check
pnpm --filter @captain/mobile test
pnpm --dir apps/mobile exec expo export --platform web --output-dir dist/web --max-workers 2
CAPTAIN_MOBILE_HARNESS=1 pnpm --dir apps/mobile exec expo export --platform web --output-dir dist-harness --max-workers 2
node apps/e2e/scripts/mobile-shell-ci.mjs
```

### Mockup comparison

Every client pull request that changes how a screen looks re-runs the side-by-side comparison against the reviewed
mockups (D14) and attaches the images to its validation record. After the two web exports above:

```sh
flock /tmp/atc-build.lock node apps/e2e/scripts/mockup-compare.mjs <record> [name,name,...]
```

It serves both exports on loopback, drives the browser suite's own check modules at 390 pixels (their synthetic API
answers and harness scenarios; the harness controls are hidden from the screenshots), renders the chat-first prototype's
frames and the R3 history-and-undo screens with the vendored fonts, and writes one PNG per screen, app on the left and
mockup on the right, to `docs/validation/<record>/compare/`. The screen names, their
app states and their mockups are the `screens` table at the top of the script; add a row when a screen gains a mockup.
Dark pairs use frames 15 to 17, or the R3 screens drawn in the dark tokens. The first record is
[fidelity-2026-10-07](../../docs/validation/fidelity-2026-10-07/README.md).

The harness is a separate, web-only export. Never deploy it. Production exports leave
`CAPTAIN_MOBILE_HARNESS` unset. The source and bundle guard excludes server packages, secret
variables and harness code from production. Only the native API URL variable `EXPO_PUBLIC_API_URL` is permitted; web API requests use
the serving origin instead.

The browser suite exercises the production session source against synthetic API answers at
360, 390, 430 and 1280 pixels, plus the retained equipment and session-revocation harness at
phone widths. It covers route retention, organisation memory, sign-out failure, invitations,
passkey listing, browser WebAuthn registration and an assertion with the new credential,
removal, failures and uncertain-write reconciliation. Members checks cover invitations, roles, removals, permissions and organisation changes. Registration and verify responses are mocked; API cookie,
CSRF, revocation and step-up tests in `apps/api/src/web/session.test.ts` require real throwaway
Postgres and provide separate server evidence.

## Fonts

The mockups' type: Fraunces SemiBold for screen headings, card, group and sheet titles, and Inter Regular, SemiBold and
Bold for everything else. The files are in `assets/fonts/` with each family's `OFL.txt`: both are licensed under the
SIL Open Font License 1.1, which permits bundling them in the app; neither declares a Reserved Font Name. They are
static instances, made with fontTools, of the variable fonts in [google/fonts](https://github.com/google/fonts) at
commit `7085eb8` (`ofl/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf` 1.000, `ofl/inter/Inter[opsz,wght].ttf` 4.001),
pinned as Google Fonts serves them to the prototype (Fraunces SOFT 0, WONK 1; Inter opsz 14) and subset to Latin,
Latin Extended and general punctuation:

```sh
python3 -m fontTools.varLib.instancer -o fr.ttf 'Fraunces[SOFT,WONK,opsz,wght].ttf' wght=600 opsz=20 SOFT=0 WONK=1   # then named "Fraunces SemiBold"
python3 -m fontTools.varLib.instancer --update-name-table -o in-600.ttf 'Inter[opsz,wght].ttf' wght=600 opsz=14     # and 400, 700
python3 -m fontTools.subset <file> --unicodes='U+0000-024F,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0300-0308,U+0329,U+1E00-1EFF,U+2000-206F,U+20AC,U+2122,U+2190-2199,U+2212,U+2215,U+2260,U+2264,U+2265,U+FEFF,U+FFFD' --layout-features='*' --name-IDs='*'
```

`src/theme/fonts.ts` loads them with `expo-font` at the root layout. On the web the page draws at once in the system
fallback and each face swaps in when loaded (`font-display: swap`); `public/index.html` turns off synthesised bold so
a semibold face is never thickened. On iOS and Android the root waits the few milliseconds the local files take.
`themedStyles` gives every text style its face from its weight (`src/theme/tokens.ts` `faces`, `faceFor`); a style
asks for Fraunces with `fontFamily: faces.display`. The type scale in `tokens.ts` is measured from the mockups.

## Colour scheme

The client follows the device's light or dark setting (`app.json` `userInterfaceStyle: automatic`; on the web,
`prefers-color-scheme`). `src/theme/tokens.ts` holds the `light` and `dark` palettes with identical keys; screens read
them only through `useTheme()` and `themedStyles()` in `src/theme/theme.ts`, never a static colour. Its test fails
any text pair under 4.5:1. `public/index.html` paints the scheme's page colour before React. The browser suite renders
the harness thread list, a thread, new thread, settings and the equipment schedule in both schemes at 390 pixels
(`apps/e2e/scripts/mobile-shell-dark-check.cjs`); see the [dark-theme record](../../docs/validation/dark-theme-2026-10-02/README.md).

`.github/workflows/mobile.yml` also exports iOS and Android JavaScript bundles, checks SDK
compatibility, generated Android backup settings, and production/harness separation. Exports
are not native builds or device evidence. Native rendering, accessibility services, safe areas,
SecureStore, app links, WebAuthn on actual devices and hosted Google sign-in remain unverified.
