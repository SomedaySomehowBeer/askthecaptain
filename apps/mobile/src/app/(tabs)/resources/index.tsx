import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';

/** Resources → Equipment schedule. */
export default function EquipmentSchedule() {
	return (
		<Screen section="resources" title="Equipment schedule">
			<Notice title="Sign in to see the equipment schedule">
				Signing in from this app is not available in this build yet. No bookings have been read, so this app does not show any equipment as free.
			</Notice>
		</Screen>
	);
}
