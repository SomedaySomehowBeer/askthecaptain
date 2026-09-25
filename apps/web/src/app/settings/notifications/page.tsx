import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { dateIn, shortDate } from '../../../lib/dates.ts';
import { Devices } from './Devices.tsx';

export const metadata: Metadata = { title: 'Notifications' };
type Config = { configured: boolean; publicKey: string | null };
type Subscription = { id: string; endpoint: string; userAgent: string; createdAt: string; lastUsedAt: string | null };

const describeAgent = (ua: string) => /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'a device';
const describeBrowser = (ua: string) => /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'a browser';

export default async function NotificationsPage() {
	const me = await requireCurrent('/settings/notifications');
	const org = me.organisation.organisationId;
	const [config, subscriptions] = await Promise.all([
		load(() => api<Config>('/v1/push/config', { token: me.token })),
		load(() => api<{ subscriptions: Subscription[] }>(`/v1/organisations/${org}/push/subscriptions`, { token: me.token }))
	]);
	return (
		<Page title="Notifications" lede="Reminders, escalations and stock count requests arrive as pushes to the devices you choose. Nothing else is sent to a device, and never mail content.">
			<section className="card">
				<h2>This device</h2>
				{!config.ok ? <Notice tone="failed" title="Push could not be checked.">{config.error.message}</Notice>
					: !config.value.configured || !config.value.publicKey ? <Notice title="Push is not set up on this Captain yet.">The owner adds the push keys on the server; until then nothing can be pushed. Everything else keeps working.</Notice>
					: <Devices publicKey={config.value.publicKey} subscribedEndpoints={subscriptions.ok ? subscriptions.value.subscriptions.map((s) => s.endpoint) : []} />}
			</section>
			<section className="card">
				<h2>Your devices</h2>
				{!subscriptions.ok ? <Notice tone="failed">{subscriptions.error.message}</Notice> : subscriptions.value.subscriptions.length === 0 ? <p className="muted">No device is subscribed for you yet.</p> : (
					<ul className="bare">{subscriptions.value.subscriptions.map((s) => (
						<li key={s.id} className="line"><span><strong>{describeBrowser(s.userAgent)} on {describeAgent(s.userAgent)}</strong><br />
							<span className="muted">since {shortDate(dateIn(s.createdAt, 'UTC'))}{s.lastUsedAt ? `, last push ${shortDate(dateIn(s.lastUsedAt, 'UTC'))}` : ', nothing sent yet'}</span></span></li>
					))}</ul>
				)}
			</section>
		</Page>
	);
}
