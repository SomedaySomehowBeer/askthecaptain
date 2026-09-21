import { DraftForm } from '../DraftForm.tsx';
import { linkThreadProject } from '../actions.ts';
import { SaveForm } from '../../commitments/SaveForm.tsx';
import { RequestDiscovery } from '../../../components/RequestDiscovery.tsx';
import { ThreadActions } from '../ThreadActions.tsx';
import { TriageFacts } from '../TriageFacts.tsx';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { attachmentsInWords, linkedByWords, mailTime, type ThreadDetail } from '../mail.ts';
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
        {thread.triageNotice ? <Notice tone="attention" action={{ href: '/settings/workflows', label: 'Review workflows' }}>{thread.triageNotice}</Notice> : null}
        {thread.triage ? <section className="card"><h2>Triage</h2><TriageFacts triage={thread.triage} /></section> : <Notice>This thread is awaiting triage.</Notice>}
        {thread.triage?.needsOwner && !thread.outbox.some(d => d.state === 'drafted') ? <ThreadActions threadId={thread.id} remindAt={thread.triage.remindAt ?? null} timezone={thread.timezone} connected={thread.connectionStatus === 'connected'} /> : null}
        <section className="card stack"><h2>Project</h2>
            {thread.projects.length > 0
                ? <p>{thread.projects.map((p, i) => <span key={p.id}>{i > 0 ? '; ' : ''}<Link href="/commitments">{p.name}</Link>{p.archivedAt ? ' (archived)' : ''}, {linkedByWords(p.linkedBy, p.rule)}</span>)}.</p>
                : <p className="muted">Not linked to a project. Triage links a thread when a rule or the model can; you can choose one here.</p>}
            {thread.projectOptions.length > 0
                ? <SaveForm action={linkThreadProject}><input type="hidden" name="threadId" value={thread.id} />
                    <div className="row"><label className="field"><span>Linked project</span>
                        <select name="projectId" defaultValue={thread.projects.find(p => !p.archivedAt)?.id ?? ''}><option value="">No project</option>{thread.projectOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                        <button className="button button--secondary button--small" type="submit">Save</button></div></SaveForm>
                : <p className="muted">Create a project on <Link href="/commitments">Commitments</Link> to link this thread to it.</p>}
            {thread.projects.length === 0 ? <RequestDiscovery kind="mail_thread" id={thread.id} /> : null}
        </section>
        {thread.outbox.map(draft => <DraftForm key={draft.id + draft.body + draft.state + (draft.remindAt ?? '')} draft={draft} connected={thread.connectionStatus === 'connected'} timezone={thread.timezone} />)}
		{thread.connectionStatus !== 'connected' ? <Notice tone="attention" action={{ href: '/settings/connections', label: 'Reconnect Google' }}>Google access is unavailable. This is the last saved copy; reconnect to receive updates.</Notice> : null}
		{thread.messages.map((m) => <article className="card stack mail-message" key={m.id}>
			<h2>{m.subject || '(No subject)'}</h2><div className="stack secondary"><p><strong>From:</strong> {m.senderContact ? <Link href={`/inbox/contacts/${m.senderContact.id}`}>{m.senderContact.name || m.senderContact.email}</Link> : m.fromHeader || 'Sender unavailable'}</p><p><strong>To:</strong> {m.toHeader || 'Recipients unavailable'}</p>
				{m.ccHeader ? <p><strong>Cc:</strong> {m.ccHeader}</p> : null}<time dateTime={m.sentAt}>{mailTime(m.sentAt, thread.timezone)}</time></div>
			{m.bodyUnavailable ? <Notice>The message body is not available in this sync. Open the message in Gmail to read it.</Notice> : <div className="mail-body">{m.body || 'This message has no text body.'}</div>}
			{m.attachments.length ? <section><h3>{attachmentsInWords(m.attachments.length)}</h3><p className="muted">Files stay in Gmail. Open the message there to view them.</p><ul>{m.attachments.map((a) => <li key={a.id}>{a.filename || 'Unnamed attachment'} — {a.mediaType}, {a.size.toLocaleString('en-AU')} bytes</li>)}</ul></section> : null}
		</article>)}
	</>;
}
