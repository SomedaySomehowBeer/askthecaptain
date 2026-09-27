/** Incoming links (docs/plans/expo-mobile-foundation-2026-09.md §5). Pure: no React Native import, so the node tests
 *  run it directly. `src/app/+native-intent.tsx` applies it before routing.
 *
 *  - Only this development build's own scheme, `app.askthecaptain.dev`, or a bare path is considered, and only with no host.
 *  - The path must pass the same safe-return rule as the API and web, then match an app route exactly.
 *  - Query strings and fragments are dropped: no route in this shell takes a parameter.
 *  - Every other link goes to the refusal screen. Sign-in callbacks are accepted only as the return value of the app's
 *    own pending authentication session (M-auth, contract §3.2 step 6), never through routing; this hook runs outside
 *    the app's state and could not check a pending attempt.
 *  - Android also delivers the callback as a system link. `systemLinkTarget` answers null (no navigation) for this
 *    build's exact callback forms, so the router never sees the code or attempt and the sign-in screen stays in place
 *    while the attempt core settles (docs/plans/expo-mobile-auth-composition-2026-09.md §5). Every other `/auth/*`
 *    path and every lookalike still goes to the refusal screen. */
export const appScheme = 'app.askthecaptain.dev';
export const refusedLink = '/link-not-allowed';

/** The paths a link may open, and the route each opens. `/resources/equipment` is the web path of the Resources default view. */
const routes = new Map<string, string>([
	['/', '/work'], ['/work', '/work'], ['/work/views', '/work/views'],
	['/chat', '/chat'], ['/chat/views', '/chat/views'],
	['/resources', '/resources'], ['/resources/views', '/resources/views'], ['/resources/equipment', '/resources'], ['/resources/inventory', '/resources/inventory']
]);
/** The routes a link can reach, for tests and for the view lists. */
export const linkableRoutes: ReadonlySet<string> = new Set(routes.values());

const maxLength = 2048;
const probe = 'https://return-path.invalid';

/** A same-origin path, unchanged, or null. This is the rule in `apps/api/src/auth/return-path.ts` (`safeReturnPath`)
 *  and `apps/web/src/lib/session-state.ts` (`safeReturn`); change all three together.
 *  - It must start with exactly one `/`: `//host` is protocol-relative.
 *  - No backslash anywhere: URL parsers read `\` as `/`, so `/\host` is `//host`.
 *  - No control characters: URL parsing strips tabs and newlines, so `/\t/host` would become `//host`.
 *  - Resolved against a fixed origin, it must stay on that origin, and its path must not begin with `//`. */
export function safeReturnPath(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
	if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
	let resolved: URL;
	try { resolved = new URL(value, probe); } catch { return null; }
	if (resolved.origin !== probe || resolved.pathname.startsWith('//')) return null;
	return value;
}

/** The route an incoming link opens: an allowed app route, or the refusal screen. */
export function linkTarget(incoming: unknown): string {
	if (typeof incoming !== 'string' || incoming.length === 0 || incoming.length > maxLength) return refusedLink;
	let rest = incoming;
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(incoming);
	if (scheme) {
		if (scheme[1]!.toLowerCase() !== appScheme) return refusedLink;
		rest = incoming.slice(scheme[0].length);
		if (rest.startsWith('//')) {
			// `app.askthecaptain.dev://host/path`: only an empty host is this app's own path form.
			const afterSlashes = rest.slice(2); const slash = afterSlashes.indexOf('/');
			if ((slash === -1 ? afterSlashes : afterSlashes.slice(0, slash)) !== '') return refusedLink;
			rest = slash === -1 ? '/' : afterSlashes.slice(slash);
		}
	}
	const safe = safeReturnPath(rest);
	if (safe === null) return refusedLink;
	const pathname = new URL(safe, probe).pathname;
	const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
	return routes.get(path) ?? refusedLink;
}

/** This build's sign-in callback as a system link, in exactly the forms the platform can deliver it: the host-less
 *  `app.askthecaptain.dev:/auth/callback` and the empty-host `app.askthecaptain.dev:///auth/callback`, each either on
 *  its own or followed by `?` and a query. The scheme is compared exactly (lower case, as the attempt core requires);
 *  the query is not read, so nothing in it is parsed, kept or logged. No fragment, no trailing slash, no other case. */
const callbackLink = new RegExp(`^${appScheme.replace(/\./g, '\\.')}:(?:///|/)auth/callback(?:\\?[^#]*)?$`);

/** What `redirectSystemPath` returns: null (no navigation) for an exact sign-in callback, otherwise `linkTarget`. */
export function systemLinkTarget(incoming: unknown): string | null {
	if (typeof incoming === 'string' && incoming.length <= maxLength && callbackLink.test(incoming)) return null;
	return linkTarget(incoming);
}
