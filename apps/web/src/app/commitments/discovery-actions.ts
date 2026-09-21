'use server';
import { revalidatePath } from 'next/cache';
import { requireCurrent } from '../../components/Page.tsx';
import { api, ApiError } from '../../lib/api.ts';
export type DiscoveryResult = { ok?: boolean; error?: string; message?: string };
const fail = (error: unknown, fallback: string): DiscoveryResult => ({ error: error instanceof ApiError ? error.message : fallback });
/** Accept makes a proposal active with its tasks open; Discard archives it and closes its candidate (D22). */
export async function decideProject(form: FormData): Promise<DiscoveryResult> {
	const me = await requireCurrent('/commitments'); const id = String(form.get('id') ?? ''); const decision = String(form.get('decision') ?? '');
	if (!id || !['accept', 'discard'].includes(decision)) return { error: 'Choose Accept or Discard.' };
	try { await api(`/v1/organisations/${me.organisation.organisationId}/projects/${encodeURIComponent(id)}/${decision}`, { method: 'POST', token: me.token }); }
	catch (error) { return fail(error, 'That did not work. Try again.'); }
	revalidatePath('/commitments'); revalidatePath('/'); return { ok: true };
}
/** Make this a project: a person chooses a thread or note; the next discovery run starts from it. */
export async function requestDiscovery(_state: DiscoveryResult | undefined, form: FormData): Promise<DiscoveryResult> {
	const me = await requireCurrent('/commitments'); const kind = String(form.get('kind') ?? ''); const id = String(form.get('id') ?? '');
	if (!id || !['mail_thread', 'note'].includes(kind)) return { error: 'Nothing to look at.' };
	try {
		const result = await api<{ queued: boolean }>(`/v1/organisations/${me.organisation.organisationId}/discovery/requests`, { method: 'POST', token: me.token, body: { kind, id } });
		return { ok: true, message: result.queued ? 'Captain is looking at this now. A proposal appears on Commitments when it is done, usually within a few minutes.' : 'Captain is already looking at this. Check Commitments shortly.' };
	} catch (error) { return fail(error, 'Captain could not start on this. Try again.'); }
}
/** Find projects now: runs the discovery workflow on demand (owner or admin). */
export async function findProjects(_state: DiscoveryResult | undefined): Promise<DiscoveryResult> {
	const me = await requireCurrent('/commitments');
	try { await api(`/v1/organisations/${me.organisation.organisationId}/workflows/discover-projects/run`, { method: 'POST', token: me.token, body: {} }); }
	catch (error) { return fail(error, 'The run could not be started. Check that Discover projects is enabled in Settings → Workflows.'); }
	return { ok: true, message: 'Looking now. Proposals appear here when the run finishes; the workflow journal in Settings → Activity shows its progress.' };
}
