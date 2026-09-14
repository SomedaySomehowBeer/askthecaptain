import { NextResponse, type NextRequest } from 'next/server';
import { api, ApiError } from '../../../lib/api.ts';
import { appUrl } from '../../../lib/env.ts';
import { cookieOptions, sessionCookie } from '../../../lib/session.ts';

/** The API sends the person here with a one-time code. The code is spent server-side for a session
 *  token, which goes into the HttpOnly cookie; the browser never holds the token in a page. */
export async function GET(request: NextRequest) {
	const code = request.nextUrl.searchParams.get('code');
	const error = request.nextUrl.searchParams.get('error');
	const signIn = new URL('/sign-in', appUrl);
	if (!code) { signIn.searchParams.set('error', error && /^[a-z_]+$/.test(error) ? error : 'request_invalid'); return NextResponse.redirect(signIn, 303); }
	try {
		const result = await api<{ token: string; expiresAt: string; returnTo: string }>('/auth/session/exchange', { method: 'POST', body: { code } });
		const response = NextResponse.redirect(new URL(result.returnTo.startsWith('/') ? result.returnTo : '/', appUrl), 303);
		response.cookies.set(sessionCookie, result.token, cookieOptions(Math.max(60, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000))));
		return response;
	} catch (caught) {
		signIn.searchParams.set('error', caught instanceof ApiError && caught.unauthorised ? 'request_invalid' : 'exchange_failed');
		return NextResponse.redirect(signIn, 303);
	}
}
