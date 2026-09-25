import { cache } from 'react';
import { cookies } from 'next/headers';
import { api, ApiError, type Me, type Membership } from './api.ts';
import { secureCookies } from './env.ts';
import { sessionFailure } from './session-state.ts';

export const sessionCookie = 'captain_session';
export const organisationCookie = 'captain_organisation';

export type Current = { token: string; me: Me; organisation: Membership | null };
/** The three things a request can know about its session. `unavailable` means the API could not
 *  say (unreachable, rate limited or failing): the saved sign-in is kept, never treated as signed
 *  out. That is not a claim the session is still valid; only a later check can say. */
export type SessionState = { state: 'signed-in'; current: Current } | { state: 'signed-out' } | { state: 'unavailable'; error: ApiError };

/** Thrown by `current()` when the session cannot be checked, so no caller mistakes an outage for
 *  a sign-out. Pages use `requireCurrent`, which turns it into the unavailable page. */
export class SessionUnavailable extends Error {
	constructor(readonly error: ApiError) { super('Captain could not check the session because its service is unavailable.'); this.name = 'SessionUnavailable'; }
}

/** Who is signed in and which organisation they are looking at, read once per request. The session
 *  token lives in an HttpOnly cookie on this host and goes to the API as a bearer; the browser never
 *  sees it in a script. Only a missing cookie or a 401 is `signed-out`. */
export const readSession = cache(async (): Promise<SessionState> => {
	const jar = await cookies();
	const token = jar.get(sessionCookie)?.value;
	if (!token) return { state: 'signed-out' };
	try {
		const me = await api<Me>('/v1/me', { token });
		const chosen = jar.get(organisationCookie)?.value;
		const organisation = me.memberships.find((m) => m.organisationId === chosen) ?? me.memberships[0] ?? null;
		return { state: 'signed-in', current: { token, me, organisation } };
	} catch (error) {
		if (sessionFailure(error) === 'signed-out') return { state: 'signed-out' };
		return { state: 'unavailable', error: error instanceof ApiError ? error : new ApiError(0, 'unavailable', 'Captain could not reach its service just now.', null) };
	}
});

/** The signed-in session, or `null` when there is none. Throws `SessionUnavailable` when the API
 *  cannot say, rather than returning `null` and sending a signed-in person to sign in. */
export async function current(): Promise<Current | null> {
	const session = await readSession();
	if (session.state === 'unavailable') throw new SessionUnavailable(session.error);
	return session.state === 'signed-in' ? session.current : null;
}

/** For server actions that report their own result: the session, or why nothing was sent. The
 *  write is never attempted when the session cannot be checked, so "nothing was sent" is true. */
export async function actionSession(): Promise<{ ok: true; token: string; org: string; current: Current } | { ok: false; reason: 'signed-out' | 'unavailable' | 'no-organisation'; error: string }> {
	const session = await readSession();
	if (session.state === 'unavailable') return { ok: false, reason: 'unavailable', error: 'Captain could not reach its service to check your session, so nothing was sent. Your sign-in has been kept; try again in a moment.' };
	if (session.state === 'signed-out') return { ok: false, reason: 'signed-out', error: 'Your session has ended. Sign in again; nothing was sent.' };
	if (!session.current.organisation) return { ok: false, reason: 'no-organisation', error: 'Choose or create an organisation first; nothing was sent.' };
	return { ok: true, token: session.current.token, org: session.current.organisation.organisationId, current: session.current };
}

export const cookieOptions = (maxAgeSeconds: number) => ({ httpOnly: true, secure: secureCookies, sameSite: 'lax' as const, path: '/', maxAge: maxAgeSeconds });
