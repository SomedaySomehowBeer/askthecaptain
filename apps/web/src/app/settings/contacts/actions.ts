'use server';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, ApiError } from '../../../lib/api.ts';
type Result = { ok?: boolean; error?: string };
export async function savePerson(_: Result | undefined, form: FormData): Promise<Result> {
 const me = await requireCurrent('/settings/contacts'); const id = String(form.get('id') ?? '');
 const kind = form.get('kind') === 'company' ? 'companies' : 'contacts';
 const archive = form.get('archived');
 const body = archive !== null ? { archived: archive === 'true' } : kind === 'companies'
  ? { name: String(form.get('name') ?? ''), domain: String(form.get('domain') ?? '').trim() || null, notes: String(form.get('notes') ?? '') }
  : { name: String(form.get('name') ?? ''), email: String(form.get('email') ?? ''), companyId: String(form.get('companyId') ?? '') || null,
   phone: String(form.get('phone') ?? ''), role: String(form.get('role') ?? ''), notes: String(form.get('notes') ?? '') };
 try {
  await api(`/v1/organisations/${me.organisation.organisationId}/${kind}${id ? `/${encodeURIComponent(id)}` : ''}`, { token: me.token, method: id ? 'PATCH' : 'POST', body });
 } catch (error) { return { error: error instanceof ApiError ? error.message : 'Could not save. Try again.' }; }
 revalidatePath('/settings/contacts'); revalidatePath('/inbox', 'layout'); return { ok: true };
}
