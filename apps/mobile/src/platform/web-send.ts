/** The web request function for the API transport (docs/plans/expo-web-session-2026-09.md §B.1). Pure: the underlying
 *  fetch is injected, so node tests prove the forced options; src/platform/fetch.ts binds it to `expo/fetch`, which on
 *  the web is the browser's own fetch.
 *
 *  On the web the app holds no token: the HttpOnly `captain_session` cookie is the session, and the API accepts it only
 *  with the header `x-captain-client: web` (its CSRF check: a cross-site page can add no such header without CORS,
 *  which the API does not offer). So, after the caller's own options and headers, and where no caller can loosen them:
 *  - `credentials: 'include'`, so the cookie is sent and a set cookie is kept;
 *  - the header `x-captain-client: web`;
 *  - `redirect: 'error'`, as on device: a redirected answer is no answer, and its body is never read;
 *  - never a bearer: any `authorization` header is dropped, so a token could not travel from the web even by mistake.
 *
 *  Every destination still comes from the fixed-origin transport (src/api/client.ts); this function adds no URL. */
import type { Send } from '../api/client.ts';

type SendInit = Parameters<Send>[1];
export const webClientHeader = 'x-captain-client';
export const webClientValue = 'web';

/** The part of the browser's fetch this uses. */
export type UnderlyingWebFetch = (url: string, init: SendInit & { redirect: 'error'; credentials: 'include' }) => ReturnType<Send>;

export function createWebSend(underlying: UnderlyingWebFetch): Send {
	return (url, init) => {
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(init.headers)) if (name.toLowerCase() !== 'authorization') headers[name] = value;
		headers[webClientHeader] = webClientValue;
		return underlying(url, { ...init, headers, redirect: 'error', credentials: 'include' });
	};
}
