'use server';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';
export async function startStocktake(form: FormData): Promise<{ runId?: string; error?: string }> {
 const me = await requireCurrent('/resources/inventory');
 try { return await api<{ runId: string }>(`/v1/organisations/${me.organisation.organisationId}/workflows/stocktake/run`, { token: me.token, method: 'POST', body: { parameters: { location: String(form.get('location') ?? '').trim() } } }); }
 catch (e) { return { error: e instanceof ApiError ? e.message : 'The stocktake could not be started. Check Activity before trying again.' }; }
}
