'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '../../../../../lib/api.ts';
import { current } from '../../../../../lib/session.ts';
import { uuid } from '../../../tags/pagination.ts';

export type LinkResult = { attached: boolean } | { error: string };

/** One tag on one task, through the existing idempotent PUT/DELETE: never a whole-set replace, so
 *  two people editing the same task cannot undo each other's other tags. */
export async function setTaskTag(form: FormData): Promise<LinkResult> {
	const taskId = String(form.get('taskId') ?? ''); const tagId = String(form.get('tagId') ?? ''); const attach = String(form.get('attach') ?? '');
	if (!uuid.test(taskId) || !uuid.test(tagId) || (attach !== 'true' && attach !== 'false')) return { error: 'That change was not understood. Refresh the page.' };
	const me = await current();
	if (!me?.organisation) return { error: 'Your session has ended. Sign in again, then try once more.' };
	try {
		const result = await api<{ attached: boolean }>(`/v1/organisations/${me.organisation.organisationId}/tasks/${taskId}/tags/${tagId}`, { method: attach === 'true' ? 'PUT' : 'DELETE', token: me.token });
		revalidatePath('/work'); revalidatePath('/work/tags'); revalidatePath(`/work/tasks/${taskId}/tags`);
		return { attached: result.attached };
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return { error: 'This task or tag can no longer be changed here. Refresh the page to see where it stands.' };
		// A refusal (4xx) means nothing changed. Anything else (unreachable, 5xx, unexpected) may have changed it.
		if (error instanceof ApiError && error.status >= 400 && error.status < 500) return { error: error.message };
		return { error: 'Captain could not confirm the change. Refresh the page to check before trying again.' };
	}
}
