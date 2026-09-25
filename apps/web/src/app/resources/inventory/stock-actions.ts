'use server';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';
export type StockResult = { error?: string; ok?: string };
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
export async function saveStock(_: StockResult | undefined, form: FormData): Promise<StockResult> {
 const me = await requireCurrent('/resources/inventory'); const org = me.organisation.organisationId;
 const operation = text(form, 'operation'); const id = text(form, 'itemId');
 let body: Record<string, unknown>; let path = `/v1/organisations/${org}/stock`; let method = 'POST'; let ok: string;
 if (operation === 'count') { path += `/${encodeURIComponent(id)}/count`; body = { count: text(form, 'count') }; ok = 'Count saved.'; }
 else if (operation === 'archive' || operation === 'restore') { path += `/${encodeURIComponent(id)}`; method = 'PATCH'; body = { archived: operation === 'archive' }; ok = operation === 'archive' ? 'Item archived.' : 'Item restored.'; }
 else if (operation === 'create' || operation === 'edit') {
  if (operation === 'edit') { path += `/${encodeURIComponent(id)}`; method = 'PATCH'; }
  body = { name: text(form, 'name'), location: text(form, 'location'), unitLabel: text(form, 'unitLabel'), reorderPoint: text(form, 'reorderPoint') || null,
   preferredSupplierId: text(form, 'preferredSupplierId') || null, notes: text(form, 'notes') }; ok = operation === 'create' ? 'Stock item added.' : 'Stock item saved.';
 } else return { error: 'That stock action was not understood.' };
 try { await api(path, { method, body, token: me.token }); }
 catch (e) { return { error: e instanceof ApiError ? e.message : 'Stock could not be saved. Try again.' }; }
 revalidatePath('/resources/inventory'); revalidatePath('/resources/inventory'); return { ok };
}
