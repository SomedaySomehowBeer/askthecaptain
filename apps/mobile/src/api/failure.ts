/** Status and error code to outcome (docs/plans/expo-mobile-auth-core-2026-09.md, with the interface review's corrections). Pure. Outcomes
 *  are never chosen by message text, only by status and the API's `code`. */
import type { ApiOutcome, AttemptOutcome, Parse, SignedIn } from '../auth/contracts.ts';
import type { Answer, Body } from './client.ts';

/** An error body's `code`, if it has one of the API's shape. */
export function errorCode(body: Body): string | null {
	if (!body.readable || typeof body.value !== 'object' || body.value === null) return null;
	const code = (body.value as { code?: unknown }).code;
	return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : null;
}

/** The rest of an error body beyond `ok`, `code`, `error` and `field`, when there is any: data a refusal carries for the
 *  client's next step (a reversal's fresh preview). Never interpreted here. */
export function errorDetail(body: Body): Record<string, unknown> | null {
	if (!body.readable || typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) return null;
	const rest = Object.fromEntries(Object.entries(body.value as Record<string, unknown>).filter(([key]) => !['ok', 'code', 'error', 'field'].includes(key)));
	return Object.keys(rest).length ? rest : null;
}

const busy = (status: number) => status === 429 || (status >= 500 && status < 600);

/** Any request other than the native exchange:
 *  - 2xx with a body that parses: ok. 2xx whose body is unreadable or doesn't parse: unavailable.
 *  - 401: unauthorised (confirmed only).
 *  - 429, 5xx, no answer (network, timeout, redirect) and any other status: unavailable, with `retry-after` if given.
 *  - Any other 4xx: refused, by the API's code (`unknown` if the body has none). */
export function apiOutcome<T>(answer: Answer, parse: Parse<T>): ApiOutcome<T> {
	if (answer.kind === 'no-answer') return { ok: false, kind: 'unavailable', status: 0 };
	const { status, retryAfter, body } = answer;
	if (status >= 200 && status < 300) {
		if (!body.readable) return { ok: false, kind: 'unavailable', status };
		try { return { ok: true, value: parse(body.value) }; } catch { return { ok: false, kind: 'unavailable', status }; }
	}
	if (status === 401) return { ok: false, kind: 'unauthorised' };
	if (busy(status)) return { ok: false, kind: 'unavailable', status, ...(retryAfter === undefined ? {} : { retryAfter }) };
	if (status >= 400 && status < 500) { const detail = errorDetail(body); return { ok: false, kind: 'refused', status, code: errorCode(body) ?? 'unknown', ...(detail ? { detail } : {}) }; }
	return { ok: false, kind: 'unavailable', status };
}

/** The native exchange, whose request is never sent twice:
 *
 *  | Answer                                                         | Outcome           |
 *  |----------------------------------------------------------------|-------------------|
 *  | 2xx with a body that parses strictly                           | `signed-in`       |
 *  | 401 `native_sign_in_disabled`                                  | `native-disabled` |
 *  | any other 401, 400, or any other 4xx except 429                | `cannot-finish`   |
 *  | 429 or 5xx                                                     | `start-again`     |
 *  | 2xx whose body is unreadable or malformed; a redirect; network | `uncertain`       |
 *  |   failure or timeout; any other status                         |                   |
 *
 *  `start-again` makes no claim that no session was created: a 5xx from a proxy can follow a committed exchange. */
export function exchangeOutcome(answer: Answer, parse: Parse<SignedIn>): AttemptOutcome {
	if (answer.kind === 'no-answer') return { kind: 'uncertain' };
	const { status, body } = answer;
	if (status >= 200 && status < 300) {
		if (!body.readable) return { kind: 'uncertain' };
		try { return { kind: 'signed-in', session: parse(body.value) }; } catch { return { kind: 'uncertain' }; }
	}
	if (status === 401 && errorCode(body) === 'native_sign_in_disabled') return { kind: 'native-disabled' };
	if (busy(status)) return { kind: 'start-again', status };
	if (status >= 400 && status < 500) return { kind: 'cannot-finish' };
	return { kind: 'uncertain' };
}
