import { useAccount } from '../account/AccountProvider.tsx';
import Welcome from './welcome.tsx';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Plus } from '../components/Icons.tsx';
import { equipmentCopy, equipmentTimesIn, threadsCopy, webCopy } from '../account/copy.ts';
import { Button } from '../components/AccountPage.tsx';
import { Notice } from '../components/Notice.tsx';
import { Screen } from '../components/Screen.tsx';
import type { Equipment } from '../resources/equipment/data.ts';
import { ReservationPanel } from '../resources/equipment/ReservationPanel.tsx';
import { panelRow, scheduleScreen, type Control, type Intent, type ScheduleScreen } from '../resources/equipment/schedule.ts';
import { Timeline } from '../resources/equipment/Timeline.tsx';
import { useEquipmentSchedule } from '../resources/equipment/useEquipmentSchedule.ts';
import { catalogueView } from '../resources/equipment/catalogue.ts';
import { newBookingHref, schedulePrefill } from '../resources/equipment/new-booking.ts';
import { CardButton } from '../threads/cards/Fields.tsx';
import { type } from '../theme/tokens.ts';
import { themedStyles, useTheme } from '../theme/theme.ts';

/** The equipment schedule, read-only, opened from its pinned row (docs/plans/expo-mobile-equipment-read-2026-09.md §5;
 *  D38: buttons only). Bookings for shared equipment across equipment and days. Only a fully read period may leave
 *  time blank, and only as "no confirmed reservations when it was read"; unread, loading, failed, partial, conflicting
 *  and stale time is hatched with its words. "New booking" (prefilled from the view) and "Manage equipment" open their
 *  own screens (bookings contract §3); a booking is changed or cancelled from its thread's card. */
export default function EquipmentPage() {
	const { snapshot } = useAccount();
	if (snapshot.account.kind === 'unverified') return <Welcome />;
	return <EquipmentSchedule />;
}

function EquipmentSchedule() {
	const styles = useStyles();
	const { colors } = useTheme();
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
	// "New booking" opens with what is on screen: the equipment column in view and the day in view (bookings contract §3).
	const onNew = () => router.push(newBookingHref(schedulePrefill({ columns: catalogueView(state.catalogue).columns, settled: state.settled, zone: screen.zone, now: Date.now() })) as never);
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
				{/* Floating, as the thread list's "New thread": it reads the view the person is looking at when they press it,
				    which a control in the scrolling header could not (reaching it scrolls the timeline to its top). */}
				{open === null ? <View style={styles.newWrap}>
					<Pressable testID="equipment-new-booking" role="button" aria-label={equipmentCopy.newBooking} onPress={onNew} style={styles.new}>
						<Plus color={colors.actionText} /><Text style={styles.newText}>{equipmentCopy.newBooking}</Text>
					</Pressable>
				</View> : null}
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
			{screen.body === 'timeline' || screen.body === 'empty' ? <View style={styles.actions}>
				<CardButton testID="equipment-manage-open" label={equipmentCopy.manage} onPress={() => router.push('/equipment/manage' as never)} />
			</View> : null}
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
	actions: { flexDirection: 'row', gap: 8 },
	// The thread list's "New thread" pill (prototype frame 1).
	newWrap: { position: 'absolute', right: 14, bottom: 18 },
	new: { minHeight: 48, paddingLeft: 14, paddingRight: 18, borderRadius: 24, backgroundColor: colors.action, flexDirection: 'row', alignItems: 'center', gap: 7, shadowColor: colors.shadow, shadowOpacity: 0.25, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 6 },
	newText: { fontSize: type.rowTitle, fontWeight: '700', color: colors.actionText },
	subtitle: { fontSize: type.small, color: colors.muted, marginTop: -8 },
	body: { fontSize: type.body, lineHeight: type.bodyLine, color: colors.body },
	detail: { fontSize: type.label, lineHeight: 17, color: colors.muted }
}));
