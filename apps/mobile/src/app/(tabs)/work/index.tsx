import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';

/** Work → My work, the default view: tasks assigned to you, across all tags. */
export default function MyWork() {
	return (
		<Screen section="work" title="My work">
			<Notice title="Sign in to see your work">
				Signing in from this app is not available in this build yet, so it shows no tasks. Your work is unchanged on the web.
			</Notice>
		</Screen>
	);
}
