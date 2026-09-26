import Link from 'next/link';
import { unreadLabel, type ConversationRow } from '../../app/chat/types.ts';
import { LocalTime } from './LocalTime.tsx';
import './chat.css';

/** One conversation in a list (the Chat list, and the "other conversations" of an item panel). Everything shown is the
 *  person's own view of it: the first link and a real link count, a labelled latest-message excerpt (never a summary),
 *  the time of the latest activity, their star and their per-conversation unread marker ("50+" at the API's cap).
 *  `compact` drops the excerpt and link chip for dense lists. Owned by the thread agent; the list imports it. */
export function ConversationRowView({ conversation: c, compact = false }: { conversation: ConversationRow; compact?: boolean }) {
	const unread = unreadLabel(c.unread);
	const at = c.lastMessageAt ?? c.createdAt;
	const first = c.linkSummary.first;
	const more = c.linkSummary.count - (first ? 1 : 0);
	const excerpt = c.latest === null ? 'No messages yet'
		: c.latest.deleted ? 'Latest message · Message deleted'
		: `Latest message · ${c.latest.authorName ?? 'Former member'}: ${c.latest.excerpt ?? ''}`;
	return <Link className={`chat-row${compact ? ' chat-row--compact' : ''}${unread ? ' chat-row--unread' : ''}`} href={`/chat/${c.id}`}>
		<span className="chat-row__main">
			<span className="chat-row__title">
				<span className="chat-row__symbol" aria-hidden="true">#</span>{c.title}
				{c.starred ? <span className="chat-row__star" aria-label="Starred" role="img">★</span> : null}
			</span>
			{!compact && first ? <span className="chat-row__links">
				<span className="chip chat-row__link">{first.kind === 'task' ? 'Task' : 'Project'}: {first.title}</span>
				{more > 0 ? <span className="chat-row__more">+{more}</span> : null}
			</span> : null}
			{!compact ? <span className="chat-row__excerpt">{excerpt}</span> : null}
		</span>
		<span className="chat-row__side">
			<LocalTime iso={at} />
			{unread ? <span className="chat-row__unread" aria-label={`${unread} unread`}>{unread}</span> : null}
		</span>
	</Link>;
}
