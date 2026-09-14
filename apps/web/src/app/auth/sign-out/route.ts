import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { api } from '../../../lib/api.ts';
import { appUrl } from '../../../lib/env.ts';
import { organisationCookie, sessionCookie } from '../../../lib/session.ts';

export async function POST() {
	const jar = await cookies();
	const token = jar.get(sessionCookie)?.value;
	if (token) await api('/auth/sign-out', { method: 'POST', token }).catch(() => undefined);
	const response = NextResponse.redirect(new URL('/sign-in', appUrl), 303);
	response.cookies.delete(sessionCookie); response.cookies.delete(organisationCookie);
	return response;
}
