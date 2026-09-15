'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { api, ApiError } from '../../../lib/api.ts';
import { current, organisationCookie } from '../../../lib/session.ts';

export type Result = { error?: string };

/** Deletes the organisation the person is looking at, after they typed its name. On success the
 *  chosen-organisation cookie is cleared and they land on the welcome page. */
export async function deleteOrganisation(_: Result | undefined, form: FormData): Promise<Result> {
	const me = await current(); if (!me?.organisation) redirect('/sign-in?return_to=/settings');
	const name = String(form.get('name') ?? '').trim();
	if (!name) return { error: 'Type the organisation’s name to delete it.' };
	try { await api(`/v1/organisations/${me.organisation.organisationId}`, { method: 'DELETE', token: me.token, body: { name } }); }
	catch (error) { return { error: error instanceof ApiError ? error.message : 'That did not work.' }; }
	(await cookies()).delete(organisationCookie);
	redirect('/welcome?deleted=1');
}
