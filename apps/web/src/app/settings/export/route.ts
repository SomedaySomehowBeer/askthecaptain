import { redirect } from 'next/navigation';
import { apiUrl } from '../../../lib/env.ts';
import { current } from '../../../lib/session.ts';

/** Streams the organisation's export from the API to the browser as a download. The session cookie
 *  stays on this host; the API sees only the bearer token, as for every other read. */
export async function GET() {
	const me = await current();
	if (!me?.organisation) redirect('/sign-in?return_to=/settings');
	const upstream = await fetch(new URL(`/v1/organisations/${me.organisation.organisationId}/export`, apiUrl), { headers: { authorization: `Bearer ${me.token}` }, cache: 'no-store' });
	if (!upstream.ok || !upstream.body) {
		const detail = (await upstream.json().catch(() => ({}))) as { error?: string };
		return new Response(detail.error ?? 'The export could not be started.', { status: upstream.status === 403 ? 403 : 502, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
	const stamp = new Date().toISOString().slice(0, 10);
	const name = me.organisation.organisationName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'organisation';
	return new Response(upstream.body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'content-disposition': `attachment; filename="captain-${name}-${stamp}.ndjson"`, 'cache-control': 'no-store' } });
}
