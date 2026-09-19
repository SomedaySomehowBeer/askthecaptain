'use server';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';
export async function updateInference(_: { error?: string; message?: string }, form: FormData): Promise<{ error?: string; message?: string }> {
 const me = await requireCurrent('/settings/inference'); const action = String(form.get('action'));
 const requests: Record<string, { path: string; method: string; body?: unknown }> = {
  create: { path: '/runtime', method: 'POST', body: { provider: form.get('provider') } },
  verify: { path: '/runtime/verify', method: 'POST' }, remove: { path: '/runtime', method: 'DELETE' },
  // The sign-in page's copy button appends the sign-in URL to the code; keep what comes before it.
  login: { path: '/runtime/login', method: 'POST' }, code: { path: '/runtime/login/code', method: 'POST', body: { code: String(form.get('code') ?? '').replace(/https?:\/\/[\s\S]*$/, '').replace(/[^A-Za-z0-9_#.:-]/g, '') } },
  budget: { path: '/budget', method: 'PATCH', body: { limitTokens: Number(form.get('limitTokens')) } }
 };
 const request = requests[action]; if (!request) return { error: 'Choose an inference action.' };
 try { await api(`/v1/organisations/${me.organisation.organisationId}/inference${request.path}`, { ...request, token: me.token }); }
 catch (error) { return { error: error instanceof ApiError ? error.message : 'That did not work. Try again.' }; }
 revalidatePath('/settings/inference');
 return { message: action === 'remove' ? 'Disconnected from Captain. Ask the operator to destroy the Sprite and remove its saved sign-in.' : 'Inference settings updated.' };
}
