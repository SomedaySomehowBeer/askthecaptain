'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, ApiError } from '../../lib/api.ts';
import { current } from '../../lib/session.ts';

export type Result = { error?: string; ok?: boolean };
const fail = (error: unknown): Result => ({ error: error instanceof ApiError ? error.message : 'That did not work.' });
const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const optional = (value: string) => value || undefined;

async function who() { const me = await current(); if (!me?.organisation) redirect('/sign-in?return_to=/commitments'); return { token: me.token, org: me.organisation.organisationId }; }
const done = (): Result => { revalidatePath('/commitments'); revalidatePath('/'); return { ok: true }; };

export async function createTask(_: Result | undefined, form: FormData): Promise<Result> {
	const { token, org } = await who();
	try {
		await api(`/v1/organisations/${org}/tasks`, { method: 'POST', token, body: { title: text(form, 'title'), projectId: optional(text(form, 'projectId')), due: optional(text(form, 'due')) ?? null, body: optional(text(form, 'body')) } });
	} catch (error) { return fail(error); }
	return done();
}

export async function setTaskStatus(form: FormData): Promise<Result> {
	const { token, org } = await who();
	const status = text(form, 'status'); const id = text(form, 'id');
	if (!['open', 'in_progress', 'done', 'cancelled'].includes(status) || !id) return { error: 'Choose a valid task status.' };
	try { await api(`/v1/organisations/${org}/tasks/${id}`, { method: 'PATCH', token, body: { status } }); } catch (error) { return fail(error); }
	return done();
}

export async function createProject(_: Result | undefined, form: FormData): Promise<Result> {
	const { token, org } = await who();
	try {
		await api(`/v1/organisations/${org}/projects`, { method: 'POST', token, body: { name: text(form, 'name'), description: optional(text(form, 'description')),
			stages: text(form, 'stages').split(',').map((s) => s.trim()).filter(Boolean) } });
	} catch (error) { return fail(error); }
	return done();
}

export async function setProjectArchived(form: FormData): Promise<Result> {
	const { token, org } = await who();
	const id = text(form, 'id'); if (!id) return { error: 'That record is not available.' };
	try { await api(`/v1/organisations/${org}/projects/${id}`, { method: 'PATCH', token, body: { archived: text(form, 'archived') === 'true' } }); } catch (error) { return fail(error); }
	return done();
}

export async function createSeries(_: Result | undefined, form: FormData): Promise<Result> {
	const { token, org } = await who();
	const recurrence = text(form, 'recurrence');
	try {
		await api(`/v1/organisations/${org}/series`, { method: 'POST', token, body: { title: text(form, 'title'), projectId: optional(text(form, 'projectId')), recurrence,
			everyMonths: recurrence === 'custom' ? Number(text(form, 'everyMonths') || '1') : null, anchor: text(form, 'anchor'), dueOffsetDays: Number(text(form, 'dueOffsetDays') || '0'),
			evidenceRequired: form.get('evidenceRequired') === 'on', body: optional(text(form, 'body')) } });
	} catch (error) { return fail(error); }
	return done();
}

export async function setSeriesPaused(form: FormData): Promise<Result> {
	const { token, org } = await who();
	const id = text(form, 'id'); if (!id) return { error: 'That record is not available.' };
	try { await api(`/v1/organisations/${org}/series/${id}`, { method: 'PATCH', token, body: { paused: text(form, 'paused') === 'true' } }); } catch (error) { return fail(error); }
	return done();
}
