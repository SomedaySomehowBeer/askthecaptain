import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { ConversationRowView } from '../../components/chat/ConversationRowView.tsx';
import { listConversations } from './actions.ts';
import { chatListHref, filterWords, parseChatListUrl, shownGroups, type ChatList } from './list-url.ts';
import type { ChatRead } from './results.ts';
import type { ListFilter, ListPage } from './types.ts';
import './chat-list.css';

export const metadata: Metadata = { title: 'Chat' };

const titles: Record<ListFilter, string> = { all: 'Conversations', unread: 'Unread', starred: 'Starred' };
const views = { href: '/chat/views', label: 'Views' };

/** What an empty group says, in words for the view it is in. */
function emptyWords(filter: ListFilter, key: 'work' | 'team'): string {
	const about = key === 'work' ? 'about a task or project' : 'with your team that are not linked to work';
	if (filter === 'unread') return `No unread conversations ${about}.`;
	if (filter === 'starred') return `Nothing starred ${about}.`;
	return `No conversations ${about} yet.`;
}

function GroupFailure({ read, retry }: { read: Exclude<ChatRead<ListPage>, { ok: true }>; retry: string }) {
	const reference = read.requestId ? ` Reference: ${read.requestId}` : '';
	if (read.kind === 'rate-limited') return <Notice title="Too many requests just now" tone="attention" action={{ href: retry, label: 'Try again' }}>{read.error}</Notice>;
	if (read.kind === 'signed-out') return <Notice title="Your session has ended" tone="attention" action={{ href: `/sign-in?return_to=${encodeURIComponent(retry)}`, label: 'Sign in' }}>{read.error}</Notice>;
	if (read.kind === 'gone') return <Notice title="Chat is not available to you here" tone="attention" action={{ href: '/chat', label: 'Reload Chat' }}>You may no longer be an active member of this organisation.{reference}</Notice>;
	return <Notice title="These conversations could not be read" tone="failed" action={{ href: retry, label: 'Try again' }}>{read.error}{reference}</Notice>;
}

/** The conversation list: the chosen view's About the work and Team conversations groups, each read and paged on its
 *  own, newest activity first. Per-conversation unread markers only; no totals anywhere. */
export default async function ChatPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const url = parseChatListUrl(await searchParams);
	const me = await requireCurrent(url.ok ? chatListHref({ filter: url.filter, linked: url.linked, cursors: url.cursors }) : '/chat');
	if (!url.ok) {
		return (
			<Page title="Conversations" parent={views}>
				<Notice title="This link could not be read" tone="attention" action={{ href: '/chat', label: 'Show all conversations' }}>{url.problem}</Notice>
			</Page>
		);
	}
	const list: ChatList = { filter: url.filter, linked: url.linked, cursors: url.cursors };
	const scope = { userId: me.me.user.id, organisationId: me.organisation.organisationId };
	const shown = shownGroups(list);
	const reads = await Promise.all(shown.map((g) => listConversations(scope, { filter: list.filter, linked: g.linked, cursor: list.cursors[g.key] })));
	const here = chatListHref(list);
	const pageOf = (key: 'work' | 'team', cursor: string | null) => chatListHref(list, key === 'work' ? { work: cursor } : { team: cursor });
	const nothingAtAll = !list.cursors.work && !list.cursors.team && reads.every((r) => r.ok && r.value.conversations.length === 0);
	const eyebrow = list.linked === true ? 'Linked to work' : list.linked === false ? 'Not linked' : undefined;

	return (
		<Page title={titles[list.filter]} parent={views} eyebrow={eyebrow}>
			<nav className="chat-filters" aria-label="Show">
				{(['all', 'unread', 'starred'] as const).map((f) => (
					<Link key={f} className="chat-filter" href={chatListHref(list, { filter: f })} aria-current={f === list.filter ? 'page' : undefined}>{filterWords[f]}</Link>
				))}
			</nav>
			{nothingAtAll ? (
				list.filter === 'all' && list.linked === null ? (
					<Notice title="No conversations yet" action={{ href: '/chat/new', label: 'Start a conversation' }}>
						Conversations you start or are added to appear here, newest activity first.
					</Notice>
				) : (
					<Notice title={list.filter === 'starred' ? 'Nothing starred' : list.filter === 'unread' ? 'Nothing unread' : 'No conversations here yet'} action={{ href: '/chat', label: 'Show all conversations' }}>
						{list.filter === 'starred' ? 'Star a conversation to keep it here.' : list.filter === 'unread' ? 'You have read every conversation in this view.' : 'Nothing matches this view yet.'}
					</Notice>
				)
			) : shown.map((g, i) => {
				const read = reads[i]!;
				const cursor = list.cursors[g.key];
				return (
					<section key={g.key} className="chat-group" aria-labelledby={`chat-group-${g.key}`}>
						<h2 id={`chat-group-${g.key}`} className="chat-group__title">{g.title}</h2>
						{!read.ok ? <GroupFailure read={read} retry={here} /> : read.value.conversations.length === 0 ? (
							cursor ? <Notice title="Nothing more here" action={{ href: pageOf(g.key, null), label: 'Back to the first page' }}>The list is shorter than this page.</Notice>
								: <p className="muted chat-group__empty">{emptyWords(list.filter, g.key)}</p>
						) : (
							<ul className="bare chat-rows" aria-label={g.title}>
								{read.value.conversations.map((c) => <li key={c.id} className="chat-rows__row"><ConversationRowView conversation={c} /></li>)}
							</ul>
						)}
						{read.ok && (cursor || read.value.nextCursor) ? (
							<nav className="chat-group__pages" aria-label={`${g.title} pages`}>
								{cursor ? <Link className="button button--ghost" href={pageOf(g.key, null)}>Newest</Link> : <span />}
								{read.value.nextCursor ? <Link className="button button--ghost" href={pageOf(g.key, read.value.nextCursor)}>More</Link> : null}
							</nav>
						) : null}
					</section>
				);
			})}
			<Link className="chat-plus" href="/chat/new" aria-label="New conversation">
				<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
			</Link>
		</Page>
	);
}
