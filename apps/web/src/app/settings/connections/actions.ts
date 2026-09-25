'use server';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';

type Result = { error?: string };
export async function disconnectGoogle(_: Result | undefined, form: FormData): Promise<Result> {
	const me = await requireCurrent('/settings/connections');
	try {
		await api(`/v1/organisations/${me.organisation.organisationId}/connections/${encodeURIComponent(String(form.get('connectionId')))}`, { method: 'DELETE', token: me.token });
	} catch (error) {
		// Only a refusal is definite; with no answer the disconnect may have happened, so say to check.
		if (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) return { error: 'Captain could not confirm the disconnection. Reload this page to see the connection’s current status before trying again.' };
		return { error: error.message };
	}
	revalidatePath('/settings/connections'); return {};
}
