import { NextResponse, type NextRequest } from 'next/server';
import { api } from '../../../lib/api.ts';
import { appUrl } from '../../../lib/env.ts';
import { callbackFailure, callbackOutcome, signInError, type CallbackOutcome, type Exchanged } from '../../../lib/native-handoff.ts';
import { cookieOptions, sessionCookie } from '../../../lib/session.ts';

/** The API sends the person here with a one-time code. The code is spent server-side for a session
 *  token, which goes into the HttpOnly cookie; the browser never holds the token in a page. A person
 *  with a passkey gets a step-up token instead and is sent to present the passkey first. A mobile app's
 *  sign-in gets a one-time handoff, which is passed to the app's fixed callback. That path sets, replaces
 *  and clears no cookie. */
export async function GET(request: NextRequest) {
	const code = request.nextUrl.searchParams.get('code');
	const error = request.nextUrl.searchParams.get('error');
	if (!code) return NextResponse.redirect(signInError(error && /^[a-z_]+$/.test(error) ? error : 'request_invalid', appUrl), 303);
	let outcome: CallbackOutcome;
	try { outcome = callbackOutcome(await api<Exchanged>('/auth/session/exchange', { method: 'POST', body: { code } }), appUrl); }
	catch (caught) { return NextResponse.redirect(signInError(callbackFailure(caught), appUrl), 303); }
	if (outcome.kind === 'native') {
		const response = NextResponse.redirect(outcome.location, 303);
		response.headers.set('cache-control', 'no-store'); response.headers.set('referrer-policy', 'no-referrer');
		return response;
	}
	if (outcome.kind === 'redirect') return NextResponse.redirect(outcome.location, 303);
	const response = NextResponse.redirect(outcome.location, 303);
	response.cookies.set(sessionCookie, outcome.token, cookieOptions(outcome.maxAgeSeconds));
	return response;
}
