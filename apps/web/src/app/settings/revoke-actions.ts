'use server';
import { redirect } from 'next/navigation';
import { api, ApiError } from '../../lib/api.ts';
import { readSession } from '../../lib/session.ts';
import { classify, type RevokeAnswer } from './revoke-classify.ts';
import type { RevokeResult } from './revoke-result.ts';

/** Sign out everywhere else (docs/plans/mobile-session-revocation-2026-09.md §3). A per-person write, so it checks the
 *  session with `readSession()` and needs no organisation. It reads no form data, sets no cookie, logs nothing and
 *  returns only a result shape from revoke-result.ts: never a token, an ID or the API's message.
 *  - Not signed in, or the session cannot be checked: nothing is sent.
 *  - A 401 after sending means this session has ended: the normal signed-out path, a redirect to sign-in. It is made
 *    after the try/catch, because a redirect thrown inside it would be caught there and lost. */
export async function revokeOtherSessions(): Promise<RevokeResult> {
	const session = await readSession();
	if (session.state !== 'signed-in') return { kind: 'not-sent', reason: session.state };
	let answer: RevokeAnswer;
	try {
		answer = { ok: true, body: await api<unknown>('/v1/me/sessions/revoke-others', { method: 'POST', token: session.current.token }) };
	} catch (error) {
		answer = error instanceof ApiError ? { ok: false, status: error.status, retryAfter: error.retryAfter } : { failed: true };
	}
	const result = classify(answer);
	if (result.kind === 'signed-out-after-send') redirect('/sign-in?return_to=%2Fsettings');
	return result;
}
