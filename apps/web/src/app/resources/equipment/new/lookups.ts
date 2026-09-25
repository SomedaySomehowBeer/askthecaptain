import { api, load, type ApiError, type Commitments, type Member } from '../../../../lib/api.ts';
import type { ReservationOptions } from '../ReservationForm.tsx';

/** Everything the reservation form needs from existing APIs, read on the server. A failed lookup
 *  comes back as `null` (with its error) so the form keeps current values instead of clearing them. */
export async function reservationLookups(token: string, org: string) {
	const [organisation, members, commitments] = await Promise.all([
		load(() => api<{ timezone: string }>(`/v1/organisations/${org}`, { token })),
		load(() => api<{ members: Member[] }>(`/v1/organisations/${org}/members`, { token })),
		load(() => api<Commitments>(`/v1/organisations/${org}/commitments`, { token }))
	]);
	const labels: Record<string, string> = {};
	if (members.ok) for (const m of members.value.members) labels[m.userId] = m.name || m.email;
	if (commitments.ok) {
		for (const p of commitments.value.projects) labels[p.id] = p.name;
		for (const t of commitments.value.tasks) labels[t.id] = t.title;
	}
	const active = commitments.ok ? commitments.value.projects.filter((p) => p.state === 'active') : [];
	const options: ReservationOptions = {
		people: members.ok ? members.value.members.filter((m) => m.status === 'active').map((m) => ({ id: m.userId, label: m.name || m.email })) : null,
		projects: commitments.ok ? active.map((p) => ({ id: p.id, label: labels[p.id]! })) : null,
		// Only what a booking may link: top-level, not cancelled, standalone or in an active project.
		tasks: commitments.ok ? commitments.value.tasks.filter((t) => !t.parentId && t.status !== 'cancelled' && (t.projectId === null || active.some((p) => p.id === t.projectId)))
			.map((t) => ({ id: t.id, label: t.title, projectId: t.projectId })) : null
	};
	const problems = [members, commitments].filter((r): r is { ok: false; error: ApiError } => !r.ok).map((r) => r.error.message);
	return { timeZone: organisation.ok ? organisation.value.timezone : null, timeZoneError: organisation.ok ? null : organisation.error, options, labels, problems };
}
