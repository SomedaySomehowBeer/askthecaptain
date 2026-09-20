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
 if (!['edit', 'send', 'discard', 'not_needed', 'remind'].includes(action)) return { error: 'Choose a draft action.' };
 const when = String(form.get('when') ?? ''); if (action === 'remind' && !['tomorrow', 'next_week'].includes(when)) return { error: 'Choose when to be reminded.' };
 try {
  await api(`/v1/organisations/${me.organisation.organisationId}/outbox/${encodeURIComponent(id)}/${action}`, { method: 'POST', token: me.token,
   ...(action === 'edit' ? { body: { body: String(form.get('body')) } } : action === 'remind' ? { body: { when } } : {}) });
 } catch (error) { revalidatePath('/inbox', 'layout'); return { error: error instanceof ApiError ? error.message : 'The draft could not be updated. Try again.' }; }
 revalidatePath('/inbox', 'layout'); return { ok: true };
}

/** Draft a reply, Not needed and Remind me later on a needs-you thread without a draft. Drafting asks the model and takes a moment. */
export async function threadAction(_state: { error?: string; ok?: boolean; message?: string } | undefined, form: FormData): Promise<{ error?: string; ok?: boolean; message?: string }> {
 const me = await requireCurrent('/inbox'); const id = String(form.get('threadId')); const action = String(form.get('action')); const when = String(form.get('when') ?? '');
 if (!['draft', 'not_needed', 'remind'].includes(action)) return { error: 'Choose an action.' };
 if (action === 'remind' && !['tomorrow', 'next_week'].includes(when)) return { error: 'Choose when to be reminded.' };
 try { await api(`/v1/organisations/${me.organisation.organisationId}/mail/threads/${encodeURIComponent(id)}/${action}`, { method: 'POST', token: me.token, ...(action === 'remind' ? { body: { when } } : {}) }); }
 catch (error) { revalidatePath('/inbox', 'layout'); return { error: error instanceof ApiError ? error.message : 'That did not work. Try again.' }; }
 revalidatePath('/inbox', 'layout');
 return { ok: true, message: action === 'draft' ? 'The draft is below. Review it; only you can send it.' : action === 'remind' ? 'Reminder set.' : 'Marked as no reply wanted.' };
}
