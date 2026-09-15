'use server';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';
export async function startWatch(_: { error?: string; ok?: boolean } | undefined) {
 const me = await requireCurrent('/settings/connections');
 try { await api(`/v1/organisations/${me.organisation.organisationId}/mail/watch`, { token: me.token, method: 'POST' }); }
 catch (error) { return { error: error instanceof ApiError ? error.message : 'Live updates could not be started. Try again.' }; }
 revalidatePath('/settings/connections'); return { ok: true };
}
