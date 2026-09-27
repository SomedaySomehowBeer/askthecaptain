import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';

/** Resources → Inventory (counted stock). */
export default function Inventory() {
	return (
		<Screen section="resources" title="Inventory">
			<Notice title="Sign in to see counted stock">
				Signing in from this app is not available in this build yet, so it shows no stock counts and cannot record one.
			</Notice>
		</Screen>
	);
}
