import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';

/** Chat → All conversations. */
export default function AllConversations() {
	return (
		<Screen section="chat" title="All conversations">
			<Notice title="Conversations aren't shown in the app yet">
				This version of the app doesn't read conversations yet, so it shows none and cannot send messages. They are unchanged on the web.
			</Notice>
		</Screen>
	);
}
