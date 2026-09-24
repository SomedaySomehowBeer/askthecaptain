import { Page } from '../../../components/Page.tsx';
import { ViewGroup } from '../../../components/ViewGroup.tsx';
export const metadata = { title: 'Chat views' };
export default function ChatViews() {
	return <Page title="Chat views" hideTitle>
		<ViewGroup title="Conversations" views={[
			{ label: 'All conversations', detail: 'Chat availability', href: '/chat' },
			{ label: 'Unread', detail: 'Conversations with new messages' },
			{ label: 'Starred', detail: 'Your personal conversation bookmarks' }
		]} />
		<ViewGroup title="Linked discussion" views={[
			{ label: 'Projects & tasks', detail: 'One conversation wherever the work appears' },
			{ label: 'Team', detail: 'Conversations with your teammates' }
		]} />
	</Page>;
}
