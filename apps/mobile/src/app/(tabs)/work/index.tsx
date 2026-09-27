import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';

/** Work → My work, the default view: tasks assigned to you, across all tags. */
export default function MyWork() {
	return (
		<Screen section="work" title="My work">
			<Notice title="Tasks aren't shown in the app yet">
				This version of the app doesn't read tasks yet, so it shows none. Your work is unchanged on the web.
			</Notice>
		</Screen>
	);
}
