'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';
type Result = { error?: string; ok?: string };
export async function connectXero(): Promise<Result> {
 const me = await requireCurrent('/settings/connections'); let target: string;
 try { target = (await api<{ authorizationUrl: string }>(`/v1/organisations/${me.organisation.organisationId}/xero/start`, { token: me.token, method: 'POST' })).authorizationUrl; }
 catch (e) { return { error: e instanceof ApiError ? e.message : 'Xero could not be connected. Try again.' }; } redirect(target);
}
export async function xeroAction(_: Result | undefined, form: FormData): Promise<Result> {
 const me = await requireCurrent('/settings/connections'); const operation = String(form.get('operation'));
 if (!['select', 'sync', 'disconnect'].includes(operation)) return { error: 'That Xero action was not understood.' };
 try { await api(`/v1/organisations/${me.organisation.organisationId}/xero/${operation === 'disconnect' ? 'connection' : operation}`, { token: me.token, method: operation === 'disconnect' ? 'DELETE' : 'POST',
  ...(operation === 'select' ? { body: { selectionId: String(form.get('selectionId')), tenantId: String(form.get('tenantId')) } } : {}) }); }
 catch (e) { revalidatePath('/settings/connections'); return { error: e instanceof ApiError ? e.message : 'Xero could not complete that action. Try again.' }; }
 revalidatePath('/settings/connections'); return { ok: operation === 'sync' ? 'Xero sync completed.' : operation === 'select' ? 'Xero is connected. Choose Sync now to read your invoices.' : 'Xero is disconnected.' };
}
