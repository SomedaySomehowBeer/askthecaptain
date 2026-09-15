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
	'https://www.googleapis.com/auth/gmail.modify': 'Gmail: read, label, draft and send',
	'https://www.googleapis.com/auth/calendar.events': 'Calendar: read, create and update events' };
const errors: Record<string, string> = {
	access_denied: 'Google access was not granted. Connect again when you are ready.',
	request_invalid: 'That connection link expired or was already used. Start again with Connect Google.',
	google_unavailable: 'Google connections are not configured. Ask the owner to finish setup.',
	scopes_missing: 'Both Gmail and Calendar access are needed. Connect again and allow both.',
	refresh_missing: 'Google did not grant offline access. Connect again and approve access.',
	forbidden: 'Only an owner or admin can connect Google. Your role may have changed.',
	not_found: 'You no longer have access to the organisation that started this connection.'
};
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
	const me = await requireCurrent('/settings/connections'); const query = await searchParams;
	return <Page title="Connections" lede={me.organisation.organisationName}>
		<Suspense fallback={<div role="status"><Notice>Checking your connections…</Notice></div>}>
			<GoogleConnection me={me} query={query} />
		</Suspense>
	</Page>;
}
async function GoogleConnection({ me, query }: { me: Awaited<ReturnType<typeof requireCurrent>>; query: { error?: string; connected?: string } }) {
	const result = await load(() => api<{ connections: Connection[]; googleAvailable: boolean }>(`/v1/organisations/${me.organisation.organisationId}/connections`, { token: me.token }));
	const google = result.ok ? result.value.connections.find((c) => c.provider === 'google') : undefined;
	const canManage = me.organisation.role !== 'member';
	return <>
		{query.error ? <Notice tone="failed">{errors[query.error] ?? 'Google could not be connected. Try Connect Google again.'}</Notice> : null}
		{query.connected === 'google' && google?.status === 'connected' ? <p role="status">Google is connected for {google.accountEmail}.</p> : null}
		<section className="card">
			<h2>Google</h2><p className="secondary">Connect Gmail and Calendar so Captain can triage the inbox and keep the calendar. Sync has not started yet.</p>
			{!result.ok ? <Notice tone="failed" action={{ href: '/settings/connections', label: 'Try again' }}>{result.error.message} Try again to check the connection.</Notice> : <>
				{google ? <div className="stack">
					<div className="line"><span>Account</span><span>{google.accountEmail}</span></div>
					<div className="line"><span>Status</span><span>{status[google.status]}</span></div>
					{google.error ? <Notice tone="attention">{google.error}</Notice> : null}
					{google.status === 'revoked' || google.status === 'refresh_failed' ? <p>Reconnect Google to restore access.</p> : null}
					<h3>{google.status === 'disconnected' ? 'Previously granted access' : 'Granted access'}</h3>
					<ul>{google.scopes.map((scope) => <li key={scope}>{scopeName[scope] ?? scope}</li>)}</ul>
				</div> : <Notice title="Google is not connected">An owner or admin can connect the business’s Google account here.</Notice>}
				{!result.value.googleAvailable ? <Notice>Google connections are not configured. Ask the owner to finish setup.</Notice> : null}
				{!canManage ? <Notice>You can see connections. Only owners and admins can connect or disconnect accounts.</Notice> : null}
				<ConnectionActions disabled={!canManage} unavailable={!result.value.googleAvailable} connectionId={google && google.status !== 'disconnected' ? google.id : undefined} reconnect={Boolean(google && google.status !== 'disconnected')} />
			</>}
		</section>
	</>;
}
