import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';

/** Resources → Equipment schedule. */
export default function EquipmentSchedule() {
	return (
		<Screen section="resources" title="Equipment schedule">
			<Notice title="The equipment schedule isn't shown in the app yet">
				This version of the app doesn't read bookings yet. No bookings have been read, so this app does not show any equipment as free.
			</Notice>
		</Screen>
	);
}
