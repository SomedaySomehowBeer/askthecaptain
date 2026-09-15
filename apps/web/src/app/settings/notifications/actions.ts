'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '../../../lib/api.ts';
import { current } from '../../../lib/session.ts';

export type Result = { error?: string; ok?: boolean; message?: string };
const fail = (error: unknown): Result => ({ error: error instanceof ApiError ? error.message : 'That did not work.' });
async function who() { const me = await current(); if (!me?.organisation) redirect('/sign-in?return_to=/settings/notifications'); return { token: me.token, org: me.organisation.organisationId }; }

/** The browser hands the server its push subscription; the server registers it with the API. The
 *  VAPID private key never leaves the API, and the API never sees the person's cookie. */
export async function registerDevice(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent: string): Promise<Result> {
	const { token, org } = await who();
	try { await api(`/v1/organisations/${org}/push/subscriptions`, { method: 'POST', token, body: { ...subscription, userAgent } }); }
	catch (error) { return fail(error); }
	revalidatePath('/settings/notifications'); return { ok: true, message: 'This device will receive Captain’s pushes.' };
}

export async function removeDevice(endpoint: string): Promise<Result> {
	const { token, org } = await who();
	try { await api(`/v1/organisations/${org}/push/subscriptions`, { method: 'DELETE', token, body: { endpoint } }); }
	catch (error) { return fail(error); }
	revalidatePath('/settings/notifications'); return { ok: true, message: 'This device will not be pushed to.' };
}

export async function sendTest(): Promise<Result> {
	const { token, org } = await who();
	try {
		const result = await api<{ deliveries: { state: string; error: string | null }[] }>(`/v1/organisations/${org}/push/test`, { method: 'POST', token });
		const sent = result.deliveries.filter((d) => d.state === 'sent').length;
		return { ok: sent > 0, message: sent > 0 ? `Sent to ${sent === 1 ? 'one device' : `${sent} devices`}.` : `Not delivered: ${result.deliveries[0]?.error ?? 'the push service refused it'}.` };
	} catch (error) { return fail(error); }
}
