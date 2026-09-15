import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { dateIn, shortDate } from '../../../lib/dates.ts';
import { AddPasskey } from './AddPasskey.tsx';
import { removePasskey } from './actions.ts';

export const metadata: Metadata = { title: 'Passkeys' };
type Passkeys = { available: boolean; passkeys: { id: string; name: string; deviceType: string; backedUp: boolean; createdAt: string; lastUsedAt: string | null }[] };

export default async function PasskeysPage() {
	const me = await requireCurrent('/settings/passkeys');
	const loaded = await load(() => api<Passkeys>('/v1/me/passkeys', { token: me.token }));
	const manages = me.me.memberships.some((m) => m.role !== 'member');
	return (
		<Page title="Passkeys" lede="A passkey is a second check at sign-in: after Google, your device confirms it is you. Once you have one, every sign-in asks for it.">
			{manages && loaded.ok && loaded.value.passkeys.length === 0 ? <Notice tone="attention" title="You manage an organisation; add a passkey.">Owners and admins are asked to protect their sign-in before invitations open beyond the crew.</Notice> : null}
			<section className="card">
				<h2>Your passkeys</h2>
				{!loaded.ok ? <Notice tone="failed">{loaded.error.message}</Notice> : !loaded.value.available ? <Notice title="Passkeys are not available on this Captain.">Sign-in stays as it is.</Notice>
					: loaded.value.passkeys.length === 0 ? <p className="muted">None yet. Sign-in is Google alone.</p> : (
					<ul className="bare">{loaded.value.passkeys.map((p) => (
						<li key={p.id} className="line"><span><strong>{p.name}</strong><br /><span className="muted">{p.backedUp ? 'synced passkey' : 'this device only'}, added {shortDate(dateIn(p.createdAt, 'UTC'))}{p.lastUsedAt ? `, last used ${shortDate(dateIn(p.lastUsedAt, 'UTC'))}` : ', not used yet'}</span></span>
							<form action={removePasskey}><input type="hidden" name="id" value={p.id} /><button className="button button--ghost button--small" type="submit">Remove</button></form></li>))}</ul>)}
			</section>
			{loaded.ok && loaded.value.available ? <section className="card"><h2>Add one</h2><AddPasskey /></section> : null}
		</Page>
	);
}
