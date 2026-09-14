'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '../../lib/api.ts';
import { cookieOptions, current, organisationCookie } from '../../lib/session.ts';

type Result = { error?: string; ok?: boolean; inviteLink?: string };
const fail = (error: unknown): Result => ({ error: error instanceof ApiError ? error.message : 'That did not work.' });

export async function updateOrganisation(_: Result | undefined, form: FormData): Promise<Result> {
	const me = await current(); if (!me?.organisation) redirect('/sign-in');
	try {
		await api(`/v1/organisations/${me.organisation.organisationId}`, { method: 'PATCH', token: me.token,
			body: { name: String(form.get('name') ?? '').trim() || undefined, timezone: String(form.get('timezone') ?? '').trim() || undefined } });
	} catch (error) { return fail(error); }
	revalidatePath('/settings'); return { ok: true };
}

export async function switchOrganisation(form: FormData): Promise<void> {
	const id = String(form.get('organisationId') ?? '');
	if (/^[0-9a-f-]{36}$/.test(id)) (await cookies()).set(organisationCookie, id, cookieOptions(365 * 24 * 60 * 60));
	redirect('/');
}

export async function invite(_: Result | undefined, form: FormData): Promise<Result> {
	const me = await current(); if (!me?.organisation) redirect('/sign-in');
	const role = String(form.get('role') ?? 'member') === 'admin' ? 'admin' : 'member';
	try {
		const result = await api<{ token: string }>(`/v1/organisations/${me.organisation.organisationId}/invitations`, { method: 'POST', token: me.token,
			body: { email: String(form.get('email') ?? '').trim(), role } });
		revalidatePath('/settings/members');
		return { ok: true, inviteLink: `${process.env.APP_URL ?? 'http://localhost:3000'}/invitations/accept?token=${encodeURIComponent(result.token)}` };
	} catch (error) { return fail(error); }
}

export async function revokeInvitation(form: FormData): Promise<void> {
	const me = await current(); if (!me?.organisation) redirect('/sign-in');
	await api(`/v1/organisations/${me.organisation.organisationId}/invitations/${String(form.get('id'))}`, { method: 'DELETE', token: me.token }).catch(() => undefined);
	revalidatePath('/settings/members');
}

export async function setRole(form: FormData): Promise<void> {
	const me = await current(); if (!me?.organisation) redirect('/sign-in');
	await api(`/v1/organisations/${me.organisation.organisationId}/members/${String(form.get('userId'))}`, { method: 'PATCH', token: me.token, body: { role: String(form.get('role')) } }).catch(() => undefined);
	revalidatePath('/settings/members');
}

export async function removeMember(form: FormData): Promise<void> {
	const me = await current(); if (!me?.organisation) redirect('/sign-in');
	await api(`/v1/organisations/${me.organisation.organisationId}/members/${String(form.get('userId'))}`, { method: 'DELETE', token: me.token }).catch(() => undefined);
	revalidatePath('/settings/members');
}
