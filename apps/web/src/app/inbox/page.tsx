import { DraftForm } from './DraftForm.tsx';
import { TriageFacts } from './TriageFacts.tsx';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '../../components/Notice.tsx';
import { withReference } from '../../components/Reference.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { api, load } from '../../lib/api.ts';
import { attachmentsInWords, mailTime, type MailList, type ThreadSummary } from './mail.ts';
import { SyncButton } from './SyncButton.tsx';
export const metadata: Metadata = { title: 'Inbox' };
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
	const me = await requireCurrent('/inbox'); const { before } = await searchParams;
	return <Page title="Inbox" lede="Mail from your connected Google account.">
		<Suspense fallback={<div role="status"><Notice>Reading your synced mail…</Notice></div>}><Inbox me={me} before={before} /></Suspense>
	</Page>;
}
async function Inbox({ me, before }: { me: Awaited<ReturnType<typeof requireCurrent>>; before?: string }) {
	const result = await load(() => api<MailList>(`/v1/organisations/${me.organisation.organisationId}/mail/threads?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`, { token: me.token }));
	if (!result.ok) return <Notice tone="failed" action={{ href: '/inbox', label: 'Try again' }}>{result.error.message} Try again to read your mail.</Notice>;
	const { connection, lastSync, threads, timezone, nextBefore, automaticSyncEnabled, triageNotice, outbox } = result.value;
	if (!connection || connection.status === 'disconnected') return <Notice title="Connect Google to see your mail" action={{ href: '/settings/connections', label: 'Go to Connections' }}>An owner or admin can connect the business’s Gmail account in Settings.</Notice>;
	const canSync = me.organisation.role !== 'member'; const available = connection.status === 'connected';
	const groups = new Map<string, ThreadSummary[]>(['Needs you', 'Waiting for a reply you drafted', 'Awaiting triage', 'Handled'].map(name => [name, []]));
	for (const thread of threads) { const day = thread.hasDraft ? 'Waiting for a reply you drafted' : !thread.triage ? 'Awaiting triage' : thread.triage.needsOwner ? 'Needs you' : 'Handled'; groups.set(day, [...(groups.get(day) ?? []), thread]); }
	return <>
		{triageNotice ? <Notice tone="attention" action={{ href: '/settings/workflows', label: 'Review workflows' }}>{triageNotice}</Notice> : null}
		<section className="card stack mail-message">
			<h2>{connection.accountEmail}</h2>
			<p className="muted">{lastSync ? `Last sync attempt: ${mailTime(lastSync.at, timezone)}.` : 'Mail has not been synced yet.'}</p>
			{!available ? <Notice tone="attention" action={{ href: '/settings/connections', label: 'Reconnect Google' }}>{connection.status === 'revoked' ? 'Google access was revoked.' : 'Google access could not be refreshed.'} Reconnect in Settings to resume mail sync. Any mail below is the last saved copy.</Notice> : null}
			{lastSync && !lastSync.detail.success ? <Notice tone="failed">{lastSync.detail.error ? withReference(lastSync.detail.error) : 'The last mail sync failed. Try Sync now again.'}</Notice> : null}
			{lastSync?.detail.capped ? <Notice>The initial sync reached its 500-thread limit. Older mail may be missing; new changes continue to sync.</Notice> : null}
			<SyncButton disabled={!canSync || !available} />
			{!canSync ? <p className="muted">Only an owner or admin can sync now.</p> : null}
			<p className="muted">{automaticSyncEnabled ? 'Connected mail is checked automatically every five minutes.' : 'Automatic mail checks are paused.'}</p>
		</section>
		{before ? <Link href="/inbox" className="button button--ghost">Newest mail</Link> : null}
		{threads.length === 0 ? <Notice title="No synced mail yet">{lastSync?.detail.success ? 'The recent-mail sync found no threads to show.' : 'Use Sync now to collect recent mail, or wait for the next automatic check.'}</Notice> : null}
		{[...groups].filter(([, items]) => items.length).map(([day, items]) => <section className="card" key={day}><h2>{day}</h2><ul className="bare">
			{items.map((thread) => <li className="mail-row" key={thread.id}><Link className="mail-link" href={`/inbox/${thread.id}`}>
				<div className="line"><strong>{thread.fromHeader || 'Sender unavailable'}</strong><time dateTime={thread.sentAt}>{mailTime(thread.sentAt, timezone)}</time></div>
				<h3>{thread.subject || '(No subject)'}</h3>{thread.triage ? <TriageFacts triage={thread.triage} /> : <p className="secondary">{thread.snippet || 'No preview available.'}</p>}
				<div className="row muted">{thread.attachmentCount > 0 ? <span>{attachmentsInWords(thread.attachmentCount)}</span> : null}{thread.labelNames.map((name) => <span className="chip" key={name}>{name}</span>)}</div>
			</Link></li>)}
		</ul></section>)}
		<section className="stack"><h2>Outbox</h2>{outbox.length ? outbox.map(draft => <div key={draft.id}>{draft.threadId ? <Link href={`/inbox/${draft.threadId}`}>Open thread: {draft.subject || '(No subject)'}</Link> : <DraftForm draft={draft} connected={available} />}</div>) : <p>No drafts awaiting you.</p>}</section>
		{nextBefore ? <Link className="button button--secondary" href={`/inbox?before=${encodeURIComponent(nextBefore)}`}>Older mail</Link> : null}
	</>;
}
