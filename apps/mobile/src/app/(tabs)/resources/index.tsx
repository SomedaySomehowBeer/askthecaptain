import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAccount } from '../../../account/AccountProvider.tsx';
import { equipmentCopy, equipmentTimesIn } from '../../../account/copy.ts';
import { Button } from '../../../components/AccountPage.tsx';
import { Notice } from '../../../components/Notice.tsx';
import { Screen } from '../../../components/Screen.tsx';
import type { Equipment, Reservation } from '../../../resources/equipment/data.ts';
import { ReservationPanel } from '../../../resources/equipment/ReservationPanel.tsx';
import { scheduleScreen, type Control, type Intent, type ScheduleScreen } from '../../../resources/equipment/schedule.ts';
import { Timeline, WebLink } from '../../../resources/equipment/Timeline.tsx';
import { useEquipmentSchedule } from '../../../resources/equipment/useEquipmentSchedule.ts';
import { colors, type } from '../../../theme/tokens.ts';

/** Resources → Equipment schedule, read-only (docs/plans/expo-mobile-equipment-read-2026-09.md §5). Bookings for shared
 *  equipment across equipment and days. Only a fully read period may leave time blank, and only as "no confirmed
 *  reservations when it was read"; unread, loading, failed, partial, conflicting and stale time is hatched with its
 *  words. There is no reserve, edit or cancel control: one fixed link opens the schedule on the website. */
export default function EquipmentSchedule() {
	const schedule = useEquipmentSchedule();
	const { webLink } = useAccount();
	const [open, setOpen] = useState<{ equipment: Equipment; reservation: Reservation } | null>(null);
	const state = schedule.state;

	// Before the scope is bound, or after it changed (the tabs are about to reset): the loading line and nothing else.
	if (schedule.inert || state === null) {
		return (
			<Screen section="resources" title={equipmentCopy.heading}>
				<Text style={styles.subtitle}>{equipmentCopy.subtitle}</Text>
				<Text testID="equipment-loading" style={styles.body}>{equipmentCopy.loading}</Text>
			</Screen>
		);
	}

	const screen = scheduleScreen(state, schedule.now(), schedule.membershipChecked);
	const web = webLink('/resources/equipment');
	const header = <Header screen={screen} onRefresh={schedule.refresh} onPress={schedule.press} />;

	if (screen.body !== 'timeline' || state.range === null || screen.zone === null) {
		return (
			<Screen section="resources" title={equipmentCopy.heading}>
				<View style={styles.stack}>
					{header}
					<Body screen={screen} onPress={schedule.press} />
					{screen.body === 'loading' ? null : <WebLink href={web} />}
				</View>
			</Screen>
		);
	}

	const zone = screen.zone;
	return (
		<Screen section="resources" title={equipmentCopy.heading} list={(frame) => (
			<View style={styles.fill}>
				<Timeline
					state={state} screen={screen} zone={zone} frame={frame} header={header}
					footer={<View style={styles.stack}><Text style={styles.detail}>{equipmentCopy.archived}</Text><WebLink href={web} /></View>}
					onSettle={schedule.settle} onScale={schedule.scale} onEdge={schedule.edge} onToday={schedule.today} onPress={schedule.press}
					onOpen={(equipment, reservation) => setOpen({ equipment, reservation })}
				/>
				{open === null ? null : (
					<ReservationPanel equipmentName={open.equipment.name} reservation={open.reservation} zone={zone} onClose={() => setOpen(null)} />
				)}
			</View>
		)} />
	);
}

/** Subtitle, zone line, Refresh, the one screen-level problem with its way out, the catalogue notices and the legend. */
function Header({ screen, onRefresh, onPress }: { screen: ScheduleScreen; onRefresh: () => boolean; onPress: (intent: Intent) => boolean }) {
	const cellRetry = screen.cellRetry;
	// With the schedule still shown (a failed Refresh keeps it, labelled stale), its Try again sits with the problem.
	const tryAgain = screen.body === 'timeline' || screen.body === 'empty' ? screen.tryAgain : null;
	return (
		<View style={styles.stack}>
			<Text testID="equipment-subtitle" style={styles.subtitle}>{equipmentCopy.subtitle}</Text>
			{screen.zone === null || screen.body === 'zone-unsupported' ? null : <Text testID="equipment-zone" style={styles.detail}>{equipmentTimesIn(screen.zone)}</Text>}
			{screen.refresh ? <ControlButton testID="equipment-refresh" label={equipmentCopy.refresh} control={screen.refresh} onPress={() => { onRefresh(); }} /> : null}
			{screen.problem === null ? null : (
				<View testID="equipment-problem"><Notice title={equipmentCopy.heading}>{screen.problem}</Notice></View>
			)}
			{tryAgain === null ? null : (
				<ControlButton testID="equipment-try-again" label={equipmentCopy.tryAgain} control={tryAgain} onPress={() => { onPress(tryAgain.intent); }} />
			)}
			{cellRetry === null ? null : (
				<ControlButton testID="equipment-cells-try-again" label={cellRetry.label} control={cellRetry} onPress={() => { onPress(cellRetry.intent); }} />
			)}
			{screen.notices.map((notice) => <Text key={notice} testID="equipment-notice" style={styles.detail}>{notice}</Text>)}
			{screen.body === 'timeline' ? <Text testID="equipment-legend" style={styles.detail}>{equipmentCopy.legend}</Text> : null}
		</View>
	);
}

/** The no-timeline states, each in words (contract §5 table). */
function Body({ screen, onPress }: { screen: ScheduleScreen; onPress: (intent: Intent) => boolean }) {
	const tryAgain = screen.tryAgain;
	const retry = tryAgain === null ? null
		: <ControlButton testID="equipment-try-again" label={equipmentCopy.tryAgain} control={tryAgain} onPress={() => { onPress(tryAgain.intent); }} />;
	switch (screen.body) {
	case 'loading': return <Text testID="equipment-loading" style={styles.body}>{equipmentCopy.loading}</Text>;
	case 'empty': return <View testID="equipment-empty"><Notice title={equipmentCopy.emptyTitle}>{equipmentCopy.emptyBody}</Notice></View>;
	default: return (
		<View testID={`equipment-${screen.body}`} style={styles.stack}>
			<Notice title={equipmentCopy.heading}>{screen.bodyText ?? equipmentCopy.failedFirst}</Notice>
			{retry}
		</View>
	);
	}
}

function ControlButton({ testID, label, control, onPress }: { testID: string; label: string; control: Control; onPress: () => void }) {
	return <Button testID={testID} label={label} disabled={control.disabled} reason={control.reason} onPress={onPress} />;
}

const styles = StyleSheet.create({
	fill: { flex: 1 },
	stack: { gap: 12 },
	subtitle: { fontSize: type.body, color: colors.muted, marginTop: -8 },
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	detail: { fontSize: 13, lineHeight: 18, color: colors.muted }
});
