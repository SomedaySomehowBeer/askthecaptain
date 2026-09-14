import { cache } from 'react';
import { cookies } from 'next/headers';
import { api, type Me, type Membership } from './api.ts';
import { secureCookies } from './env.ts';

export const sessionCookie = 'captain_session';
export const organisationCookie = 'captain_organisation';

export type Current = { token: string; me: Me; organisation: Membership | null };

/** Who is signed in and which organisation they are looking at, read once per request. The session
 *  token lives in an HttpOnly cookie on this host and goes to the API as a bearer; the browser never
 *  sees it in a script. A missing or dead session is `null`, not an error. */
export const current = cache(async (): Promise<Current | null> => {
	const jar = await cookies();
	const token = jar.get(sessionCookie)?.value;
	if (!token) return null;
	try {
		const me = await api<Me>('/v1/me', { token });
		const chosen = jar.get(organisationCookie)?.value;
		const organisation = me.memberships.find((m) => m.organisationId === chosen) ?? me.memberships[0] ?? null;
		return { token, me, organisation };
	} catch { return null; }
});

export const cookieOptions = (maxAgeSeconds: number) => ({ httpOnly: true, secure: secureCookies, sameSite: 'lax' as const, path: '/', maxAge: maxAgeSeconds });
