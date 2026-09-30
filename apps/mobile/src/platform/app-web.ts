/** The web binding of the account (docs/plans/expo-web-session-2026-09.md §B.1). Typecheck-only: it reads the browser's
 *  location, storage and clock, so node tests cover `createWebSession` with fakes.
 *
 *  The API serves the web export from its own origin (§A.1), so the page's own origin is the API origin: the same
 *  export runs on staging and production without a build-time address. It is validated with the transport's origin
 *  rule; a loopback http origin is allowed (the browser check serves the export there), any other http origin is not.
 *  A refused origin gives the fixed `misconfigured` source, which the welcome page says in words.
 *
 *  Nothing here runs at import: the first `/v1/me` is sent when the root layout asks for the source. */
import { createApiClient, createTransport, apiOrigin } from '../api/client.ts';
import { fixedAccountSource, outsideSnapshots, type AccountSource } from '../account/account-source.ts';
import { createWebSession } from '../account/web-session.ts';
import { webSend } from './fetch.ts';
import { createOrganisationMemory } from './web-storage.ts';

/** The page's origin as the API origin, or null when it is not usable. */
export function pageOrigin(location: { readonly origin?: unknown } | undefined): string | null {
	try { return apiOrigin(location?.origin, true); } catch { return null; }
}

export function webAccountSource(): AccountSource {
	const origin = pageOrigin(typeof window === 'undefined' ? undefined : window.location);
	if (origin === null) return fixedAccountSource(outsideSnapshots.misconfigured);
	const transport = createTransport({ origin, send: webSend });
	const source = createWebSession({
		client: createApiClient(transport), origin,
		memory: createOrganisationMemory(() => (typeof window === 'undefined' ? null : window.localStorage)),
		monotonicNow: () => performance.now()
	});
	source.start();
	return source;
}
