'use server';
import { requireCurrent } from '../../../components/Page.tsx';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError, type WorkflowParameterSpec, type WorkflowRunDetail } from '../../../lib/api.ts';
import { isRetiredWorkflow } from './retired.ts';

export type Result = { error?: string; ok?: boolean };

/** Enable or disable one workflow with the parameters from its form. Enabling is the authorisation
 *  (plan §3): the workflow acts in this person's name from now on, so the API records who. */
export async function setWorkflow(_: Result | undefined, form: FormData): Promise<Result> {
	const me = await requireCurrent('/settings/workflows');
	// Save parameters is distinct from the on/off toggle and keeps the workflow enabled.
	const key = String(form.get('key') ?? ''); const enabled = form.get('intent') === 'save' || String(form.get('enabled') ?? '') === 'true';
	if (enabled && isRetiredWorkflow(key)) return { error: 'That workflow has been retired and cannot be turned on.' };
	let specs: Record<string, WorkflowParameterSpec> = {};
	try { specs = JSON.parse(String(form.get('specs') ?? '{}')) as Record<string, WorkflowParameterSpec>; } catch { return { error: 'The form was not understood.' }; }
	const parameters: Record<string, unknown> = {};
	for (const [name, spec] of Object.entries(specs)) {
		const raw = form.get(`param.${name}`);
		if (spec.type === 'boolean') parameters[name] = raw === 'on';
		else if (spec.type === 'number') { const value = String(raw ?? '').trim(); if (value) parameters[name] = Number(value); }
		else { const value = String(raw ?? '').trim(); if (value || spec.required) parameters[name] = value; }
	}
	try { await api(`/v1/organisations/${me.organisation.organisationId}/workflows/${encodeURIComponent(key)}`, { method: 'PUT', token: me.token, body: { enabled, parameters } }); }
	catch (error) { return { error: error instanceof ApiError ? error.message : 'That did not work.' }; }
	revalidatePath('/settings/workflows'); return { ok: true };
}

export async function controlRun(_: Result | undefined, form: FormData): Promise<Result> {
 const me = await requireCurrent('/settings/workflows');
 const action = String(form.get('action')); const id = String(form.get('id'));
 if (!['run', 'resume', 'cancel'].includes(action)) return { error: 'That action was not understood.' };
 // A run or resume of a retired workflow is refused here too; the API is still the authority.
 if (action === 'run' && isRetiredWorkflow(id)) return { error: 'That workflow has been retired and cannot be run.' };
 if (action === 'resume') {
  let run: WorkflowRunDetail;
  try { run = await api<WorkflowRunDetail>(`/v1/organisations/${me.organisation.organisationId}/workflows/runs/${encodeURIComponent(id)}`, { token: me.token }); }
  catch (error) { return { error: error instanceof ApiError ? error.message : 'That did not work.' }; }
  if (isRetiredWorkflow(run.definitionKey, run.definitionVersion)) return { error: 'That workflow has been retired: its run can be cancelled but not resumed.' };
 }
 const path = action === 'run' ? `${encodeURIComponent(id)}/run` : `runs/${encodeURIComponent(id)}/${action}`;
 try { await api(`/v1/organisations/${me.organisation.organisationId}/workflows/${path}`, { method: 'POST', token: me.token }); }
 catch (error) { return { error: error instanceof ApiError ? error.message : 'That did not work.' }; }
 revalidatePath('/settings/workflows'); return { ok: true };
}
