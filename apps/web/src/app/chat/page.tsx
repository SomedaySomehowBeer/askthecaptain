import { Page } from '../../components/Page.tsx';
import { Notice } from '../../components/Notice.tsx';
export const metadata = { title: 'Chat' };
export default function ChatPage() {
	return <Page title="Conversations"><Notice title="Chat is not available yet.">
		Team conversations, shared pins and linked discussions are still being built.
	</Notice></Page>;
}
