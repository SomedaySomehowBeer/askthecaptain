'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';

type Result = { error?: string };
export async function connectGoogle(): Promise<Result> {
	const me = await requireCurrent('/settings/connections'); let target: string;
	try {
		const result = await api<{ authorizationUrl: string }>(`/v1/organisations/${me.organisation.organisationId}/connections/google/start`, { method: 'POST', token: me.token });
		target = result.authorizationUrl;
	} catch (error) { return { error: error instanceof ApiError ? error.message : 'Google could not be connected. Try again.' }; }
	redirect(target);
}
export async function disconnectGoogle(_: Result | undefined, form: FormData): Promise<Result> {
	const me = await requireCurrent('/settings/connections');
	try {
		await api(`/v1/organisations/${me.organisation.organisationId}/connections/${encodeURIComponent(String(form.get('connectionId')))}`, { method: 'DELETE', token: me.token });
	} catch (error) { return { error: error instanceof ApiError ? error.message : 'Google could not be disconnected. Try again.' }; }
	revalidatePath('/settings/connections'); return {};
}
