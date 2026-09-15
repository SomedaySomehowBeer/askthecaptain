'use server';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';
export async function shopifyAction(form: FormData): Promise<{ error?: string; authorizationUrl?: string }> {
 const me = await requireCurrent('/settings/connections'); const root = `/v1/organisations/${me.organisation.organisationId}/shopify`; const operation = String(form.get('operation'));
 try {
  if (operation === 'start') return await api<{ authorizationUrl: string }>(`${root}/start`, { token: me.token, method: 'POST', body: { shop: String(form.get('shop') ?? '') } });
  if (operation === 'sync' || operation === 'disconnect') { await api(`${root}/${operation === 'sync' ? 'sync' : 'connection'}`, { token: me.token, method: operation === 'sync' ? 'POST' : 'DELETE' }); return {}; }
  if (operation === 'reorder') { await api(`${root}/stock/${encodeURIComponent(String(form.get('itemId')))}`, { token: me.token, method: 'PATCH', body: { reorderPoint: String(form.get('reorderPoint') ?? '').trim() || null } }); return {}; }
  return { error: 'That Shopify action was not understood.' };
 } catch (e) { return { error: e instanceof ApiError ? e.message : 'Shopify could not complete that action. Check the connection and try again.' }; }
}
