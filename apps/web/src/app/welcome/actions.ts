'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError } from '../../lib/api.ts';
import { cookieOptions, current, organisationCookie } from '../../lib/session.ts';

export async function createOrganisation(_: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
	const me = await current(); if (!me) redirect('/sign-in?return_to=/welcome');
	const name = String(form.get('name') ?? '').trim();
	const timezone = String(form.get('timezone') ?? '').trim() || undefined;
	if (!name) return { error: 'Give the organisation a name.' };
	try {
		const org = await api<{ id: string }>('/v1/organisations', { method: 'POST', token: me.token, body: { name, timezone } });
		(await cookies()).set(organisationCookie, org.id, cookieOptions(365 * 24 * 60 * 60));
	} catch (error) { return { error: error instanceof ApiError ? error.message : 'That did not work.' }; }
	redirect('/');
}
