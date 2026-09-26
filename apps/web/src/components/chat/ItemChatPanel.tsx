import Link from 'next/link';
import { conversationsFor, readMessages, readPins } from '../../app/chat/actions.ts';
import { chatLimits, type LinkKind } from '../../app/chat/types.ts';
import { AccessLost } from './AccessLost.tsx';
import { ConversationRowView } from './ConversationRowView.tsx';
import { ItemChatLive } from './ItemChatLive.tsx';
import { chatViewer } from './viewer.ts';
import './chat.css';

/** The Chat section of a task or project (plan §1 "Work panels"). The most recent linked conversation the person is in
 *  opens here with its live pins, latest messages, row menus and a composer; the rest are listed as rows. It never
 *  polls and never moves read position: "Check for new messages" reads again, and "Open chat" goes to the thread. */
export async function ItemChatPanel({ me, kind, targetId, href }: {
	me: Parameters<typeof chatViewer>[0]; kind: LinkKind; targetId: string; href: string;
}) {
	const viewer = await chatViewer(me);
	const noun = kind === 'task' ? 'task' : 'project';
	const start = `/chat/new?link=${kind}:${targetId}`;
	const list = await conversationsFor(viewer.scope, kind, targetId);
	const heading = <h2 id={`chat-${targetId}`}>Chat</h2>;

	if (!list.ok) return <section className="chat-panel" aria-labelledby={`chat-${targetId}`}>
		{heading}
		<div className="card notice notice--failed" role="alert">
			<p>Conversations about this {noun} could not be read. {list.kind === 'rate-limited' ? `Try again in ${list.retryAfter} seconds.` : list.error}</p>
			<Link className="button button--secondary" href={href}>Try again</Link>
		</div>
	</section>;

	const rows = list.value.conversations.slice(0, chatLimits.itemPanelRows);
	if (rows.length === 0) return <section className="chat-panel" aria-labelledby={`chat-${targetId}`}>
		{heading}
		<p className="muted">No conversations about this {noun} yet.</p>
		<Link className="button button--secondary" href={start}>Start a conversation</Link>
	</section>;

	const [first, ...others] = rows as [typeof rows[number], ...typeof rows];
	const [messages, pins] = await Promise.all([readMessages(viewer.scope, first.id, { latest: chatLimits.panelLatest }), readPins(viewer.scope, first.id)]);
	return <section className="chat-panel" aria-labelledby={`chat-${targetId}`}>
		<div className="chat-panel__head">{heading}<Link className="chat-panel__open" href={`/chat/${first.id}`}>Open chat <span aria-hidden="true">›</span></Link></div>
		<p className="chat-panel__context">Linked to this {noun}. Only people in a conversation can see it.</p>
		{messages.ok && pins.ok
			? <ItemChatLive key={first.id} viewer={viewer} row={first} messages={messages.value} pins={pins.value} />
			: (!messages.ok && messages.kind === 'gone') || (!pins.ok && pins.kind === 'gone')
				? <AccessLost scope={viewer.scope} conversationId={first.id} />
				: <>
					<div className="chat-panel__card"><ConversationRowView conversation={first} /></div>
					<p className="muted" role="status">Its latest messages could not be read. Open the chat, or reload this page to try again.</p>
				</>}
		{others.length ? <>
			<h3 className="chat-panel__subhead">Other conversations about this {noun}</h3>
			<ul className="bare chat-panel__others">{others.map(row => <li key={row.id}><ConversationRowView conversation={row} compact /></li>)}</ul>
		</> : null}
		<Link className="button button--ghost" href={start}>Start another conversation</Link>
	</section>;
}
