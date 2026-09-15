'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '../../../lib/api.ts';
import { current } from '../../../lib/session.ts';

export type Result = { error?: string; ok?: boolean };
async function who() { const me = await current(); if (!me) redirect('/sign-in?return_to=/settings/passkeys'); return me; }
const fail = (error: unknown) => ({ error: error instanceof ApiError ? error.message : 'That did not work.' });

export async function registrationOptions(): Promise<{ token?: string; options?: unknown; error?: string }> {
	const me = await who();
	try { return await api<{ token: string; options: unknown }>('/v1/me/passkeys/options', { method: 'POST', token: me.token }); } catch (error) { return fail(error); }
}

export async function registerPasskey(token: string, name: string, response: unknown): Promise<Result> {
	const me = await who();
	try { await api('/v1/me/passkeys', { method: 'POST', token: me.token, body: { token, name, response } }); } catch (error) { return fail(error); }
	revalidatePath('/settings/passkeys'); revalidatePath('/settings'); return { ok: true };
}

export async function removePasskey(form: FormData): Promise<void> {
	const me = await who();
	const id = String(form.get('id') ?? ''); if (!/^[0-9a-f-]{36}$/.test(id)) return;
	await api(`/v1/me/passkeys/${id}`, { method: 'DELETE', token: me.token }).catch(() => undefined);
	revalidatePath('/settings/passkeys'); revalidatePath('/settings');
}
