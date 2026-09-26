import Link from 'next/link';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { ViewGroup } from '../../../components/ViewGroup.tsx';
import { chatViewLinks } from '../list-url.ts';
import '../chat-list.css';

export const metadata = { title: 'Chat views' };

/** Chat's grouped view list, one page left of the conversations (D11). Each view is a filter and linked pair; none
 *  shows a count. */
export default async function ChatViews() {
	await requireCurrent('/chat/views');
	const group = (name: 'Conversations' | 'Linked to work') => chatViewLinks.filter((v) => v.group === name).map(({ label, detail, href }) => ({ label, detail, href }));
	return <Page title="Chat views" hideTitle>
		<ViewGroup title="Conversations" views={group('Conversations')} />
		<ViewGroup title="Linked to work" views={group('Linked to work')} />
		<Link className="chat-plus" href="/chat/new" aria-label="New conversation">
			<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
		</Link>
	</Page>;
}
