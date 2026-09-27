'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError } from '../../../lib/api.ts';
import { nativeTarget, type HandoffAnswer, type SessionAnswer } from '../../../lib/native-handoff.ts';
import { cookieOptions, sessionCookie } from '../../../lib/session.ts';
import { safeReturn } from '../../../lib/session-state.ts';

/** `nativeTarget` is set only for a mobile app's step-up: the page hands it to the app. */
export type Result = { error?: string; nativeTarget?: string };

/** Step 1 of the step-up: the API's assertion options for this one-time token. */
export async function stepUpOptions(token: string): Promise<{ options?: unknown; error?: string }> {
	try { return await api<{ options: unknown }>('/auth/passkey/options', { method: 'POST', body: { token } }); }
	catch (error) { return { error: error instanceof ApiError ? error.message : 'The sign-in could not continue.' }; }
}

/** Step 2: the browser's assertion goes to the API. For a web sign-in the session token comes back and into
 *  the cookie. For a mobile app's sign-in a one-time handoff comes back: no cookie is set, replaced or
 *  cleared, and the page passes the handoff to the app's fixed callback. The action never redirects to a
 *  non-HTTP scheme itself. */
export async function stepUpVerify(token: string, response: unknown): Promise<Result> {
	let result: SessionAnswer | HandoffAnswer;
	try { result = await api('/auth/passkey/verify', { method: 'POST', body: { token, response } }); }
	catch (error) { return { error: error instanceof ApiError ? error.message : 'The passkey could not be checked.' }; }
	if ('nativeHandoff' in result) {
		const target = nativeTarget(result);
		return target ? { nativeTarget: target } : { error: 'The sign-in could not be handed back to the app. Start again from the app.' };
	}
	(await cookies()).set(sessionCookie, result.token, cookieOptions(Math.max(60, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000))));
	redirect(safeReturn(result.returnTo, '/'));
}
