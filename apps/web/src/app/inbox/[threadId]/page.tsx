import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { attachmentsInWords, mailTime, type ThreadDetail } from '../mail.ts';
export const metadata: Metadata = { title: 'Mail thread' };
export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
	const { threadId } = await params; const me = await requireCurrent(`/inbox/${threadId}`);
	return <Page title="Mail thread"><Link href="/inbox" className="button button--ghost">Back to Inbox</Link>
		<Suspense fallback={<div role="status"><Notice>Reading this thread…</Notice></div>}><Thread me={me} id={threadId} /></Suspense>
	</Page>;
}
async function Thread({ me, id }: { me: Awaited<ReturnType<typeof requireCurrent>>; id: string }) {
	const result = await load(() => api<ThreadDetail>(`/v1/organisations/${me.organisation.organisationId}/mail/threads/${encodeURIComponent(id)}`, { token: me.token }));
	if (!result.ok) return <Notice tone="failed" action={{ href: '/inbox', label: 'Return to Inbox' }}>{result.error.message}</Notice>;
	const thread = result.value;
	return <>
		{thread.connectionStatus !== 'connected' ? <Notice tone="attention" action={{ href: '/settings/connections', label: 'Reconnect Google' }}>Google access is unavailable. This is the last saved copy; reconnect to receive updates.</Notice> : null}
		{thread.messages.map((m) => <article className="card stack mail-message" key={m.id}>
			<h2>{m.subject || '(No subject)'}</h2><div className="stack secondary"><p><strong>From:</strong> {m.senderContact ? <Link href={`/inbox/contacts/${m.senderContact.id}`}>{m.senderContact.name || m.senderContact.email}</Link> : m.fromHeader || 'Sender unavailable'}</p><p><strong>To:</strong> {m.toHeader || 'Recipients unavailable'}</p>
				{m.ccHeader ? <p><strong>Cc:</strong> {m.ccHeader}</p> : null}<time dateTime={m.sentAt}>{mailTime(m.sentAt, thread.timezone)}</time></div>
			{m.bodyUnavailable ? <Notice>The message body is not available in this sync. Open the message in Gmail to read it.</Notice> : <div className="mail-body">{m.body || 'This message has no text body.'}</div>}
			{m.attachments.length ? <section><h3>{attachmentsInWords(m.attachments.length)}</h3><p className="muted">Files stay in Gmail. Open the message there to view them.</p><ul>{m.attachments.map((a) => <li key={a.id}>{a.filename || 'Unnamed attachment'} — {a.mediaType}, {a.size.toLocaleString('en-AU')} bytes</li>)}</ul></section> : null}
		</article>)}
	</>;
}
