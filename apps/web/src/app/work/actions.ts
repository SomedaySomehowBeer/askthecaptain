'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError, type Task } from '../../lib/api.ts';
import { actionSession } from '../../lib/session.ts';

export type CreateResult = { id: string } | { error: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();

/** One task through the existing `POST /tasks` (D7), owned by the person chosen, by default the
 *  person creating it. Tags are not attached here: that would be a second write after this one. */
export async function createWorkTask(form: FormData): Promise<CreateResult> {
	const session = await actionSession();
	if (!session.ok) return { error: session.error };
	const title = text(form, 'title'); const ownerId = text(form, 'ownerId'); const projectId = text(form, 'projectId');
	const due = text(form, 'due'); const body = text(form, 'body');
	if (!title) return { error: 'Give the task a title.' };
	if (title.length > 200) return { error: 'Keep the title to 200 characters.' };
	if (!uuid.test(ownerId)) return { error: 'Choose who owns the task.' };
	if (projectId && !uuid.test(projectId)) return { error: 'Choose a project from the list.' };
	if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { error: 'Give the due date as a date.' };
	if (body.length > 5000) return { error: 'Keep the notes to 5,000 characters.' };
	try {
		const task = await api<Task>(`/v1/organisations/${session.org}/tasks`, { method: 'POST', token: session.token,
			body: { title, ownerId, projectId: projectId || undefined, due: due || null, body: body || undefined } });
		revalidatePath('/work'); revalidatePath('/commitments');
		return { id: task.id };
	} catch (error) {
		return { error: error instanceof ApiError && error.status >= 400 && error.status < 500 ? error.message : 'The save could not be confirmed. Check Work before trying again.' };
	}
}
