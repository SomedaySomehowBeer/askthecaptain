import { api, load, type Organisation } from '../../lib/api.ts';
import type { Current } from '../../lib/session.ts';
import type { Viewer } from './viewer-types.ts';

/** Server-only: the viewer for a chat page. The organisation's timezone is read from the organisation because the
 *  session does not carry it; if that read fails, the page still works and says times are in UTC. */
export async function chatViewer(me: Current & { organisation: NonNullable<Current['organisation']> }): Promise<Viewer> {
	const organisationId = me.organisation.organisationId;
	const organisation = await load(() => api<Organisation>(`/v1/organisations/${organisationId}`, { token: me.token }));
	const timezone = organisation.ok && validZone(organisation.value.timezone) ? organisation.value.timezone : null;
	return { scope: { userId: me.me.user.id, organisationId }, userId: me.me.user.id, role: me.organisation.role,
		timezone: timezone ?? 'UTC', timezoneKnown: timezone !== null };
}

function validZone(zone: string): boolean {
	try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}
