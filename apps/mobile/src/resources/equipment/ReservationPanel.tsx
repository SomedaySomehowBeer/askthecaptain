import { StyleSheet, Text, View } from 'react-native';
import {
	equipmentCopy, reservationBuffersText, reservationKindText, reservationOccupiedText, reservationSpanText, type FormatInstant
} from '../../account/copy.ts';
import { Button } from '../../components/AccountPage.tsx';
import { colors, space, type } from '../../theme/tokens.ts';
import type { Reservation } from './data.ts';
import { displayTime } from './zone.ts';

/** A reservation time in the organisation zone with its UTC offset. The zone passed the gate, so this doesn't fail;
 *  if it ever did, the exact instant is shown instead of a device-local time. */
export const zoneTime = (zone: string): FormatInstant => (instant) => {
	try { return displayTime(instant, zone); } catch { return instant; }
};

/** The read-only detail for a tapped bar (contract §5 "Detail panel"): built only from the row already loaded, the
 *  equipment name and the zone. No read, route, deep link or write. */
export function ReservationPanel({ equipmentName, reservation, zone, onClose }: {
	equipmentName: string; reservation: Reservation; zone: string; onClose: () => void;
}) {
	const time = zoneTime(zone);
	const buffers = reservationBuffersText(reservation);
	return (
		<View testID="equipment-panel" role="dialog" aria-label={reservation.title} style={styles.panel}>
			<Text style={styles.equipment}>{equipmentName}</Text>
			<Text role="heading" style={styles.title}>{reservation.title}</Text>
			<Text style={styles.body}>{reservationKindText(reservation.kind)}</Text>
			<Text style={styles.body}>{reservationSpanText(reservation, time)}</Text>
			{buffers === null ? null : <Text style={styles.body}>{buffers}</Text>}
			<Text style={styles.detail}>{reservationOccupiedText(reservation, time)}</Text>
			<Text style={styles.detail}>{equipmentCopy.panelNote}</Text>
			<Button testID="equipment-panel-close" label={equipmentCopy.close} onPress={onClose} />
		</View>
	);
}

const styles = StyleSheet.create({
	panel: {
		position: 'absolute', left: space.page, right: space.page, bottom: 24, gap: 6, padding: 16,
		backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.line,
		shadowColor: colors.heading, shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 6
	},
	equipment: { fontSize: 13, fontWeight: '600', color: colors.muted },
	title: { fontSize: 18, fontWeight: '600', color: colors.heading },
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	detail: { fontSize: 13, lineHeight: 18, color: colors.muted }
});
