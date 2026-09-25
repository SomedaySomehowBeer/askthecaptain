import { ShopifyCard } from './ShopifyCard.tsx';
import { XeroCard } from './XeroCard.tsx';
import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { ConnectionActions } from './ConnectionActions.tsx';
export const metadata: Metadata = { title: 'Connections' };
type Connection = { id: string; provider: string; accountEmail: string; scopes: string[]; status: 'connected' | 'refresh_failed' | 'revoked' | 'disconnected'; error: string | null };
const status = { connected: 'Connected', refresh_failed: 'Access could not be refreshed', revoked: 'Google access revoked', disconnected: 'Disconnected' };
const scopeName: Record<string, string> = { openid: 'Google account identity', email: 'Email address',
	'https://www.googleapis.com/auth/userinfo.email': 'Email address',
	'https://www.googleapis.com/auth/userinfo.profile': 'Name and profile picture',
	'https://www.googleapis.com/auth/gmail.modify': 'Gmail: read, label, draft and send',
	'https://www.googleapis.com/auth/calendar.calendarlist.readonly': 'Calendar: read your calendar list',
	'https://www.googleapis.com/auth/calendar.events': 'Calendar: read, create and update events' };
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string; xero?: string; shopify?: string }> }) {
	const me = await requireCurrent('/settings/connections'); const query = await searchParams;
	return <Page title="Connections" lede={me.organisation.organisationName}>
		<Suspense fallback={<div role="status"><Notice>Checking your connections…</Notice></div>}>
			<GoogleConnection me={me} query={query} />
		</Suspense>
		<Suspense fallback={<div role="status"><Notice>Checking Xero…</Notice></div>}><XeroCard me={me} outcome={query.xero} /></Suspense>
		<Suspense fallback={<p role="status">Checking Shopify…</p>}><ShopifyCard me={me} outcome={query.shopify} /></Suspense>
	</Page>;
}
/** Google mail and calendar access belonged to the retired assistant (#133). Captain no longer offers
 *  to connect it, and nothing is revoked automatically. An existing grant is shown as it stands so an
 *  owner or admin can decide to disconnect it; Google sign-in is separate and unaffected. */
async function GoogleConnection({ me, query }: { me: Awaited<ReturnType<typeof requireCurrent>>; query: { error?: string; connected?: string } }) {
	const result = await load(() => api<{ connections: Connection[]; googleAvailable: boolean }>(`/v1/organisations/${me.organisation.organisationId}/connections`, { token: me.token }));
	const google = result.ok ? result.value.connections.find((c) => c.provider === 'google') : undefined;
	const canManage = me.organisation.role !== 'member';
	const notice = query.error || query.connected === 'google'
		? <Notice tone="attention">Google mail and calendar connections are no longer offered. Nothing was connected.</Notice> : null;
	if (!result.ok) return <>{notice}<Notice tone="failed" action={{ href: '/settings/connections', label: 'Try again' }}>{result.error.message} The existing Google connection, if any, could not be checked.</Notice></>;
	if (!google || google.status === 'disconnected') return notice;
	return <>
		{notice}
		<section className="card">
			<h2>Google (retired mail and calendar access)</h2>
			<p className="secondary">Captain no longer uses Gmail or Google Calendar. This earlier connection has been left as it was: nothing was revoked automatically. Signing in with Google does not depend on it.</p>
			<div className="stack">
				<div className="line"><span>Account</span><span>{google.accountEmail}</span></div>
				<div className="line"><span>Status</span><span>{status[google.status]}</span></div>
				{google.error ? <Notice tone="attention">{google.error}</Notice> : null}
				<h3>Access Google granted</h3>
				<ul>{google.scopes.map((scope) => <li key={scope}>{scopeName[scope] ?? scope}</li>)}</ul>
			</div>
			<p className="muted">Disconnecting asks Google to revoke this access and removes the stored credentials from Captain. It does not delete anything else. If Google cannot confirm the revocation, Captain says so and you can remove access in your Google account’s permissions.</p>
			{canManage ? <ConnectionActions connectionId={google.id} /> : <Notice>Only owners and admins can disconnect this account.</Notice>}
		</section>
	</>;
}
