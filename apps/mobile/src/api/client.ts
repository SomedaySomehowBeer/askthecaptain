/** The only request path (mobile foundation contract §4 "Transport"; docs/plans/expo-mobile-auth-core-2026-09.md and
 *  docs/plans/expo-mobile-platform-account-2026-09.md). Pure: the function that sends is injected as `send`, and URLs
 *  are handled as text, not with URL, whose React Native implementation is partial.
 *
 *  - Every URL is the configured API origin plus an ApiPath. Nothing a server sends is ever used as a URL, and a bearer
 *    is attached only to such a URL.
 *  - Every request asks for `redirect: 'error'`. React Native's global `fetch` ignores that option (it is `whatwg-fetch`
 *    over XMLHttpRequest), so the app never uses it: on device `send` is `nativeSend` from src/platform/fetch.ts, which
 *    is `expo/fetch` with `redirect: 'error'` and `credentials: 'omit'` forced. Source reading shows expo/fetch refuses
 *    the redirect natively on iOS and Android; that is not claimed as proven until the device redirect check (including
 *    an encoded organisation path) passes. The API test apps/api/src/auth/no-redirect.test.ts is representative
 *    evidence that the routes the app calls answer no 3xx; it is not a guarantee for every route, a proxy in front of
 *    the API, or native behaviour.
 *  - Second line only: a response that says it was redirected, has a 3xx status, or whose final URL is not exactly the
 *    requested URL is treated as no answer, and its body is never read.
 *  - Nothing is retried here, and no error or thrown message carries a token, code, verifier or attempt. */
import type { ApiClient, ApiOutcome, Parse } from '../auth/contracts.ts';
import { apiOutcome } from './failure.ts';
import { apiPaths, type ApiPath } from './paths.ts';

/** What the transport needs from the function that sends a request: a fetch-shaped call. In the app it is `nativeSend`
 *  (src/platform/fetch.ts); tests pass fakes. */
export type Send = (url: string, init: {
	method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal
}) => Promise<{
	status: number; redirected: boolean; url: string; headers: { get(name: string): string | null }; text(): Promise<string>
}>;

/** A response's body: parsed JSON, or unreadable (not JSON, or the read failed or timed out). */
export type Body = { readonly readable: true; readonly value: unknown } | { readonly readable: false };
/** One request's result, before any mapping (src/api/failure.ts maps it). */
export type Answer =
	| { readonly kind: 'answered'; readonly status: number; readonly retryAfter?: number; readonly body: Body }
	/** Nothing usable arrived: a network failure, the timeout, or a redirect (refused, or reported afterwards). The
	 *  request may still have reached the server. */
	| { readonly kind: 'no-answer'; readonly reason: 'network' | 'timeout' | 'redirect' };

export type Transport = {
	/** The configured API origin, for building the sign-in start URL. */
	readonly origin: string;
	/** Sends one request, once. `token` must be a well-formed session token or null (anything else throws before
	 *  sending); `body`, when given, is sent as JSON. */
	request(method: 'GET' | 'POST', path: ApiPath, token: string | null, body?: unknown): Promise<Answer>;
};

/** The shape of every session token the API issues: `sess_` and 32 random bytes in base64url (apps/api/src/auth/
 *  service.ts). The same rule as the credential store's (src/account/session.ts), so any token the exchange accepts can
 *  be saved. */
export const sessionToken = /^sess_[A-Za-z0-9_-]{43}$/;

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const originShape = /^(https?):\/\/([a-z0-9.-]+|\[::1\])(?::(\d{1,5}))?\/?$/;

/** The configured API URL as a canonical origin (`scheme://host[:port]`), or a TypeError that doesn't repeat the value.
 *  https is required; http only for a loopback host and only when `allowLoopbackHttp` (development builds). The value
 *  must be lower case, with no credentials, path, query or fragment, and no port that is the scheme's default. */
export function apiOrigin(configured: unknown, allowLoopbackHttp: boolean): string {
	const match = typeof configured === 'string' ? originShape.exec(configured) : null;
	if (!match) throw new TypeError('API URL: not an origin (lower-case scheme and host, no path, query or credentials)');
	const scheme = match[1]!; const host = match[2]!; const port = match[3];
	if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) throw new TypeError('API URL: the host is not valid');
	if (port !== undefined && (String(Number(port)) !== port || Number(port) < 1 || Number(port) > 65535 || port === (scheme === 'https' ? '443' : '80')))
		throw new TypeError('API URL: the port is not valid');
	if (scheme === 'http' && !(allowLoopbackHttp && loopbackHosts.has(host))) throw new TypeError('API URL: https is required');
	return `${scheme}://${host}${port === undefined ? '' : `:${port}`}`;
}

const retryAfterSeconds = (value: string | null): number | undefined => {
	const trimmed = value?.trim();
	return trimmed !== undefined && /^\d{1,6}$/.test(trimmed) ? Number(trimmed) : undefined;
};

/** The transport over an injected `send`. `origin` must come from apiOrigin. One timer covers the whole request,
 *  including reading the body. */
export function createTransport(options: { origin: string; send: Send; timeoutMs?: number }): Transport {
	const { origin, send } = options; const timeoutMs = options.timeoutMs ?? 30_000;
	return {
		origin,
		async request(method, path, token, body) {
			if (token !== null && !sessionToken.test(token)) throw new TypeError('transport: the session token is not well formed');
			const url = `${origin}${path}`;
			const headers: Record<string, string> = { accept: 'application/json' };
			if (token !== null) headers.authorization = `Bearer ${token}`;
			if (body !== undefined) headers['content-type'] = 'application/json';
			const controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<{ timeout: true }>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ timeout: true }); }, timeoutMs); });
			try {
				const sent = send(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: controller.signal });
				sent.catch(() => undefined);
				const response = await Promise.race([sent, timedOut]);
				if ('timeout' in response) return { kind: 'no-answer', reason: 'timeout' };
				if (response.redirected || response.url !== url || (response.status >= 300 && response.status < 400)) return { kind: 'no-answer', reason: 'redirect' };
				const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
				const read = await Promise.race([response.text().then((text) => ({ text }), () => null), timedOut.then(() => null)]);
				let parsed: Body = { readable: false };
				if (read !== null) { try { parsed = { readable: true, value: JSON.parse(read.text) as unknown }; } catch { /* unreadable */ } }
				return { kind: 'answered', status: response.status, ...(retryAfter === undefined ? {} : { retryAfter }), body: parsed };
			} catch {
				return { kind: 'no-answer', reason: 'network' };
			} finally { clearTimeout(timer); }
		}
	};
}

/** The ApiClient the account runner uses. A malformed token is never sent: it answers `unauthorised`. The native
 *  exchange is not reachable through it; the attempt core owns that single request. */
export function createApiClient(transport: Transport): ApiClient {
	const call = async <T>(method: 'GET' | 'POST', path: ApiPath, token: string | null, body: unknown, parse: Parse<T>): Promise<ApiOutcome<T>> => {
		if (path === apiPaths.nativeExchange) throw new TypeError('client: the native exchange belongs to the attempt core');
		if (token !== null && !sessionToken.test(token)) return { ok: false, kind: 'unauthorised' };
		return apiOutcome(await transport.request(method, path, token, body), parse);
	};
	return {
		get: (path, token, parse) => call('GET', path, token, undefined, parse),
		post: (path, token, body, parse) => call('POST', path, token, body, parse)
	};
}
