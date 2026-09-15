'use server';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../components/Page.tsx';
import { api, ApiError } from '../../lib/api.ts';
export async function syncMail(): Promise<{ error?: string; ok?: boolean }> {
	const me = await requireCurrent('/inbox');
	try { await api(`/v1/organisations/${me.organisation.organisationId}/mail/sync`, { method: 'POST', token: me.token }); }
	catch (error) { revalidatePath('/inbox'); return { error: error instanceof ApiError ? error.message : 'Mail could not be synced. Try again.' }; }
	revalidatePath('/inbox', 'layout'); return { ok: true };
}
