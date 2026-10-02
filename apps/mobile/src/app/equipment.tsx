import { useAccount } from '../account/AccountProvider.tsx';
import Welcome from './welcome.tsx';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { equipmentCopy, equipmentTimesIn, threadsCopy, webCopy } from '../account/copy.ts';
import { Button } from '../components/AccountPage.tsx';
import { Notice } from '../components/Notice.tsx';
import { Screen } from '../components/Screen.tsx';
import type { Equipment } from '../resources/equipment/data.ts';
import { ReservationPanel } from '../resources/equipment/ReservationPanel.tsx';
import { panelRow, scheduleScreen, type Control, type Intent, type ScheduleScreen } from '../resources/equipment/schedule.ts';
import { Timeline } from '../resources/equipment/Timeline.tsx';
import { useEquipmentSchedule } from '../resources/equipment/useEquipmentSchedule.ts';
import { type } from '../theme/tokens.ts';
import { themedStyles } from '../theme/theme.ts';

/** The equipment schedule, read-only, opened from its pinned row (docs/plans/expo-mobile-equipment-read-2026-09.md §5;
 *  D38: buttons only). Bookings for shared equipment across equipment and days. Only a fully read period may leave
 *  time blank, and only as "no confirmed reservations when it was read"; unread, loading, failed, partial, conflicting
 *  and stale time is hatched with its words. There is no reserve, edit or cancel control yet. */
export default function EquipmentPage() {
	const { snapshot } = useAccount();
	if (snapshot.account.kind === 'unverified') return <Welcome />;
	return <EquipmentSchedule />;
}

function EquipmentSchedule() {
	const styles = useStyles();
	const schedule = useEquipmentSchedule();
	const [open, setOpen] = useState<{ equipment: Equipment; reservationId: string } | null>(null);
	const state = schedule.state;
	// The panel shows only a reservation still drawn for its equipment; it closes once it is no longer returned or has
	// been contradicted (review S2).
	const row = open === null || state === null ? null : panelRow(state, open.equipment.id, open.reservationId);
	useEffect(() => { if (open !== null && row === null) setOpen(null); }, [open, row]);
	const back = { label: threadsCopy.heading, onPress: () => { if (router.canGoBack()) router.back(); else router.replace('/'); } };

	// Before the scope is bound (the account still being checked), or after it changed (the list is about to take
	// over): the loading line and nothing else.
	if (schedule.inert || state === null) {
		return (
			<Screen back={back} title={equipmentCopy.heading}>
				<Text style={styles.subtitle}>{equipmentCopy.subtitle}</Text>
				<Text testID="equipment-loading" style={styles.body}>{schedule.checking ? webCopy.checking : equipmentCopy.loading}</Text>
			</Screen>
		);
	}

	const screen = scheduleScreen(state, schedule.now(), schedule.membershipChecked);
	const header = <Header screen={screen} onRefresh={schedule.refresh} onPress={schedule.press} />;

	if (screen.body !== 'timeline' || state.range === null || screen.zone === null) {
		return (
			<Screen back={back} title={equipmentCopy.heading}>
				<View style={styles.stack}>
					{header}
					<Body screen={screen} onPress={schedule.press} />
				</View>
			</Screen>
		);
	}

	const zone = screen.zone;
	return (
		<Screen back={back} title={equipmentCopy.heading} list={(frame) => (
			<View style={styles.fill}>
				<Timeline
					state={state} screen={screen} zone={zone} frame={frame} header={header} footer={null}
					onSettle={schedule.settle} onScale={schedule.scale} onEdge={schedule.edge} onToday={schedule.today} onPress={schedule.press}
					onOpen={(equipment, reservation) => setOpen({ equipment, reservationId: reservation.id })}
				/>
				{open === null || row === null ? null : (
					<ReservationPanel equipmentName={open.equipment.name} reservation={row} zone={zone} onClose={() => setOpen(null)} />
				)}
			</View>
		)} />
	);
}

/** Subtitle, zone line, Refresh, the one screen-level problem with its way out, the catalogue notices and the legend. */
function Header({ screen, onRefresh, onPress }: { screen: ScheduleScreen; onRefresh: () => boolean; onPress: (intent: Intent) => boolean }) {
	const styles = useStyles();
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
			{/* Archived equipment isn't listed, so the header says so where the legend is read (review S4). */}
			{screen.body === 'timeline' || screen.body === 'empty' ? <Text testID="equipment-archived" style={styles.detail}>{equipmentCopy.archived}</Text> : null}
		</View>
	);
}

/** The no-timeline states, each in words (contract §5 table). */
function Body({ screen, onPress }: { screen: ScheduleScreen; onPress: (intent: Intent) => boolean }) {
	const styles = useStyles();
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

const useStyles = themedStyles((colors) => ({
	fill: { flex: 1 },
	stack: { gap: 12 },
	subtitle: { fontSize: type.body, color: colors.muted, marginTop: -8 },
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	detail: { fontSize: 13, lineHeight: 18, color: colors.muted }
}));
