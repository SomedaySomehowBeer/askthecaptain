'use server';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../components/Page.tsx';
import { api, ApiError } from '../../lib/api.ts';
export async function syncCalendar(): Promise<{ error?: string; ok?: boolean }> {
	const me = await requireCurrent('/calendar');
	try { await api(`/v1/organisations/${me.organisation.organisationId}/calendar/sync`, { method: 'POST', token: me.token }); }
	catch (error) { revalidatePath('/calendar'); return { error: error instanceof ApiError ? error.message : 'Calendar could not be synced. Try again.' }; }
	revalidatePath('/calendar', 'layout'); return { ok: true };
}
