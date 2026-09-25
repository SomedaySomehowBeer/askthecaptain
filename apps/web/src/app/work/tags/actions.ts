'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '../../../lib/api.ts';
import { actionSession } from '../../../lib/session.ts';
import type { Tag } from '../types.ts';
import { tagName, uuid } from './pagination.ts';

export type TagResult = { tag: Tag } | { error: string };

/** A tag label is the organisation's, so a rename shows on every task that carries it (D7). */
function refreshTagViews() {
	revalidatePath('/work'); revalidatePath('/work/tags'); revalidatePath('/work/tasks/[taskId]/tags', 'page');
}
async function write(path: string, method: 'POST' | 'PATCH', name: string): Promise<TagResult> {
	const session = await actionSession();
	if (!session.ok) return { error: session.error };
	try {
		const tag = await api<Tag>(`/v1/organisations/${session.org}/tags${path}`, { method, token: session.token, body: { name } });
		refreshTagViews();
		return { tag };
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) return { error: 'That tag is no longer available. Refresh the list.' };
		// A refusal (4xx) means nothing changed. Anything else (unreachable, 5xx, unexpected) may have saved.
		if (error instanceof ApiError && error.status >= 400 && error.status < 500) return { error: error.message };
		return { error: 'Captain could not confirm whether that was saved. Refresh the list to check before trying again.' };
	}
}

export async function createTag(form: FormData): Promise<TagResult> {
	const name = tagName(form.get('name'));
	return typeof name === 'string' ? write('', 'POST', name) : name;
}

export async function renameTag(form: FormData): Promise<TagResult> {
	const id = String(form.get('id') ?? '');
	if (!uuid.test(id)) return { error: 'That tag reference is not valid. Refresh the list.' };
	const name = tagName(form.get('name'));
	return typeof name === 'string' ? write(`/${id}`, 'PATCH', name) : name;
}
