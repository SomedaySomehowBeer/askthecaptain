import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';

/** Chat → All conversations. */
export default function AllConversations() {
	return (
		<Screen section="chat" title="All conversations">
			<Notice title="Sign in to see your conversations">
				Signing in from this app is not available in this build yet, so it shows no conversations and cannot send messages.
			</Notice>
		</Screen>
	);
}
