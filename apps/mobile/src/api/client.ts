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
 *  - Nothing is retried here, and no error or thrown message carries a token, code, verifier or attempt.
 *  - The body is read as a byte stream under a fixed budget (docs/plans/expo-mobile-response-byte-budget-2026-09.md):
 *    at most `maxResponseBytes` decoded bytes are kept, decoded and given to `JSON.parse`. A body that would exceed it,
 *    is not valid UTF-8, or doesn't finish within the one request timer is unreadable, keeping the status and
 *    `retry-after`. This bounds what JavaScript keeps and parses only: what native code buffered before streaming, and
 *    the size of one delivered chunk, are not bounded here (device gates). */
import type { ApiClient, ApiOutcome, Parse } from '../auth/contracts.ts';
import { apiOutcome } from './failure.ts';
import { apiPaths, type ApiPath } from './paths.ts';

/** The most decoded (after transport decompression) body bytes any single API response may have. A policy limit, not a
 *  measured worst case; one limit for every response. */
export const maxResponseBytes = 1_048_576;

/** The part of a response body stream's reader the transport uses. `closed` is left out on purpose: it is never read. */
export type BodyReader = {
	read(): Promise<{ done: boolean; value?: unknown }>;
	cancel(reason?: unknown): Promise<unknown>;
	releaseLock(): void;
};

/** What the transport needs from the function that sends a request: a fetch-shaped call whose response body is a byte
 *  stream (`expo/fetch`, browser and Node responses all have one). In the app it is `nativeSend` (src/platform/fetch.ts);
 *  tests pass fakes. */
export type Send = (url: string, init: {
	method: 'GET' | 'POST' | 'DELETE' | 'PATCH'; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal
}) => Promise<{
	status: number; redirected: boolean; url: string; headers: { get(name: string): string | null };
	readonly body: { getReader(): BodyReader } | null
}>;
type SentResponse = Awaited<ReturnType<Send>>;

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
	request(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: ApiPath, token: string | null, body?: unknown): Promise<Answer>;
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

/** Whether a `content-length` value declares more than `maxResponseBytes`. Only an all-digits value counts; it is
 *  compared by length first (leading zeros ignored), so a huge value never goes through Number. Anything else, or no
 *  header, declares nothing: the byte count decides. */
function declaresTooMany(value: string | null): boolean {
	if (value === null || !/^\d+$/.test(value)) return false;
	const digits = value.replace(/^0+(?=\d)/, ''); const limit = String(maxResponseBytes);
	return digits.length > limit.length || (digits.length === limit.length && digits > limit);
}

/** One request's stop state, shared by the request and its body read. Not public. */
type StopState = { stopped: boolean; reader: BodyReader | null; readonly parts: string[] };

/** Every non-normal exit: stop the read loop first, drop decoded text, then cancel the stream and abort the request.
 *  Idempotent, and each cleanup call is guarded, so nothing here can throw or change the outcome already decided. */
function halt(state: StopState, controller: AbortController, reason: string): void {
	state.stopped = true;
	state.parts.length = 0;
	const reader = state.reader; state.reader = null;
	if (reader !== null) { try { void reader.cancel(reason).catch(() => undefined); } catch { /* best effort */ } }
	try { controller.abort(); } catch { /* best effort */ }
}

const unreadable = (): Body => ({ readable: false });

/** Reads the body as a byte stream within `maxResponseBytes`. Never rejects. After any `read()` settles, a stopped
 *  request does nothing more: no check, count, decode, further read or parse. Counting comes before decoding, so a
 *  chunk that crosses the budget is never decoded. One fatal UTF-8 decoder decodes chunk by chunk (split sequences are
 *  carried across chunks; a leading BOM is removed); the bytes are never joined. */
async function readBody(response: SentResponse, state: StopState, controller: AbortController): Promise<Body> {
	try {
		const body = response.body;
		if (body === null) return unreadable();
		const reader = body.getReader(); state.reader = reader;
		const decoder = new TextDecoder('utf-8', { fatal: true });
		let total = 0;
		for (;;) {
			let result: Awaited<ReturnType<BodyReader['read']>>;
			try { result = await reader.read(); } catch (error) { if (state.stopped) return unreadable(); throw error; }
			if (state.stopped) return unreadable();
			if (result.done) {
				const rest = decoder.decode();
				if (rest !== '') state.parts.push(rest);
				const text = state.parts.join('');
				state.parts.length = 0; state.reader = null;
				try { reader.releaseLock(); } catch { /* nothing reads this body again */ }
				return { readable: true, value: JSON.parse(text) as unknown };
			}
			const value = result.value;
			if (!(value instanceof Uint8Array)) { halt(state, controller, 'unreadable'); return unreadable(); }
			if (total + value.byteLength > maxResponseBytes) { halt(state, controller, 'budget'); return unreadable(); }
			total += value.byteLength;
			// A zero-byte chunk, or one ending mid-character, decodes to '' and adds no entry.
			const decoded = decoder.decode(value, { stream: true });
			if (decoded !== '') state.parts.push(decoded);
		}
	} catch {
		if (!state.stopped) halt(state, controller, 'error');
		return unreadable();
	}
}

/** The transport over an injected `send`. `origin` must come from apiOrigin. One timer covers the whole request,
 *  including reading the body; when it fires it settles the request first and only then cleans up, so a cleanup call
 *  that throws can never leave the request unsettled. */
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
			const state: StopState = { stopped: false, reader: null, parts: [] };
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<{ timeout: true }>((resolve) => {
				timer = setTimeout(() => { resolve({ timeout: true }); halt(state, controller, 'timeout'); }, timeoutMs);
			});
			try {
				const sent = send(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: controller.signal });
				sent.catch(() => undefined);
				const response = await Promise.race([sent, timedOut]);
				if ('timeout' in response) return { kind: 'no-answer', reason: 'timeout' };
				// Refused without touching the body; request cancellation without relying on native buffering behaviour.
				if (response.redirected || response.url !== url || (response.status >= 300 && response.status < 400)) {
					halt(state, controller, 'redirect');
					return { kind: 'no-answer', reason: 'redirect' };
				}
				const status = response.status;
				const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
				const answered = (parsed: Body): Answer => ({ kind: 'answered', status, ...(retryAfter === undefined ? {} : { retryAfter }), body: parsed });
				// Refused before the body is touched: on expo/fetch the `body` getter creates the stream.
				if (declaresTooMany(response.headers.get('content-length'))) { halt(state, controller, 'too-large'); return answered(unreadable()); }
				const loop = readBody(response, state, controller);
				loop.catch(() => undefined);
				return answered(await Promise.race([loop, timedOut.then(unreadable)]));
			} catch {
				halt(state, controller, 'error');
				return { kind: 'no-answer', reason: 'network' };
			} finally { clearTimeout(timer); }
		}
	};
}

/** The ApiClient the account runner uses. A malformed token is never sent: it answers `unauthorised`. The native
 *  exchange is not reachable through it; the attempt core owns that single request. */
export function createApiClient(transport: Transport): ApiClient {
	const call = async <T>(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: ApiPath, token: string | null, body: unknown, parse: Parse<T>): Promise<ApiOutcome<T>> => {
		if (path === apiPaths.nativeExchange) throw new TypeError('client: the native exchange belongs to the attempt core');
		if (token !== null && !sessionToken.test(token)) return { ok: false, kind: 'unauthorised' };
		return apiOutcome(await transport.request(method, path, token, body), parse);
	};
	return {
		get: (path, token, parse) => call('GET', path, token, undefined, parse),
		patch: (path, token, body, parse) => call('PATCH', path, token, body, parse),
		delete: (path, token, parse, body) => call('DELETE', path, token, body, parse),
		post: (path, token, body, parse) => call('POST', path, token, body, parse)
	};
}
