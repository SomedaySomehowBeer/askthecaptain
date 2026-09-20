'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireCurrent } from '../../components/Page.tsx';
import { api, ApiError } from '../../lib/api.ts';
export type Result = { error?: string } | void;
const body = (form: FormData) => ({ title: String(form.get('title') ?? '').trim(), body: String(form.get('body') ?? ''),
 projectId: String(form.get('projectId') ?? '') || null, taskId: String(form.get('taskId') ?? '') || null, contactId: String(form.get('contactId') ?? '') || null, companyId: String(form.get('companyId') ?? '') || null, eventId: String(form.get('eventId') ?? '') || null });
/** Saving a note is the one write here; triage reads it afterwards on its own. */
export async function createNote(_: unknown, form: FormData): Promise<Result> {
 const me = await requireCurrent('/notes'); let id: string;
 try { ({ id } = await api<{ id: string }>(`/v1/organisations/${me.organisation.organisationId}/notes`, { method: 'POST', token: me.token, body: body(form) })); }
 catch (error) { return { error: error instanceof ApiError ? error.message : 'The note could not be saved. Try again.' }; }
 revalidatePath('/notes'); revalidatePath('/'); redirect(`/notes/${id}`);
}
export async function updateNote(_: unknown, form: FormData): Promise<Result> {
 const me = await requireCurrent('/notes'); const id = String(form.get('id'));
 try { await api(`/v1/organisations/${me.organisation.organisationId}/notes/${encodeURIComponent(id)}`, { method: 'PUT', token: me.token, body: body(form) }); }
 catch (error) { return { error: error instanceof ApiError ? error.message : 'The note could not be saved. Try again.' }; }
 revalidatePath('/notes', 'layout'); revalidatePath('/');
}
export async function archiveNote(_: unknown, form: FormData): Promise<Result> {
 const me = await requireCurrent('/notes'); const id = String(form.get('id'));
 try { await api(`/v1/organisations/${me.organisation.organisationId}/notes/${encodeURIComponent(id)}/archive`, { method: 'POST', token: me.token }); }
 catch (error) { return { error: error instanceof ApiError ? error.message : 'The note could not be archived. Try again.' }; }
 revalidatePath('/notes', 'layout'); revalidatePath('/'); redirect('/notes');
}
