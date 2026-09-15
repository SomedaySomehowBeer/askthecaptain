'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError } from '../../../lib/api.ts';
import { cookieOptions, sessionCookie } from '../../../lib/session.ts';

export type Result = { error?: string };

/** Step 1 of the step-up: the API's assertion options for this one-time token. */
export async function stepUpOptions(token: string): Promise<{ options?: unknown; error?: string }> {
	try { return await api<{ options: unknown }>('/auth/passkey/options', { method: 'POST', body: { token } }); }
	catch (error) { return { error: error instanceof ApiError ? error.message : 'The sign-in could not continue.' }; }
}

/** Step 2: the browser's assertion goes to the API; the session token comes back and into the cookie. */
export async function stepUpVerify(token: string, response: unknown): Promise<Result> {
	let result: { token: string; expiresAt: string; returnTo: string };
	try { result = await api('/auth/passkey/verify', { method: 'POST', body: { token, response } }); }
	catch (error) { return { error: error instanceof ApiError ? error.message : 'The passkey could not be checked.' }; }
	(await cookies()).set(sessionCookie, result.token, cookieOptions(Math.max(60, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000))));
	redirect(result.returnTo.startsWith('/') && !result.returnTo.startsWith('//') ? result.returnTo : '/');
}
