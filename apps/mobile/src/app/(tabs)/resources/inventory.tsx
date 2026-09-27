import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';

/** Resources → Inventory (counted stock). */
export default function Inventory() {
	return (
		<Screen section="resources" title="Inventory">
			<Notice title="Counted stock isn't shown in the app yet">
				This version of the app doesn't read stock yet, so it shows no stock counts and cannot record one.
			</Notice>
		</Screen>
	);
}
