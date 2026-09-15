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

export async function changeDraft(_state: { error?: string; ok?: boolean } | undefined, form: FormData): Promise<{ error?: string; ok?: boolean }> {
 const me = await requireCurrent('/inbox'); const id = String(form.get('id')); const action = String(form.get('action'));
 if (!['edit', 'send', 'discard'].includes(action)) return { error: 'Choose a draft action.' };
 try {
  await api(`/v1/organisations/${me.organisation.organisationId}/outbox/${encodeURIComponent(id)}/${action}`, { method: 'POST', token: me.token,
   ...(action === 'edit' ? { body: { body: String(form.get('body')) } } : {}) });
 } catch (error) { revalidatePath('/inbox', 'layout'); return { error: error instanceof ApiError ? error.message : 'The draft could not be updated. Try again.' }; }
 revalidatePath('/inbox', 'layout'); return { ok: true };
}
