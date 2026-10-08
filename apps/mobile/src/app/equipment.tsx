import { useAccount } from '../account/AccountProvider.tsx';
import Welcome from './welcome.tsx';
import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Chevron, Plus } from '../components/Icons.tsx';
import { equipmentCopy, equipmentTimesIn, threadsCopy, webCopy } from '../account/copy.ts';
import { Button } from '../components/AccountPage.tsx';
import { Notice } from '../components/Notice.tsx';
import { Screen } from '../components/Screen.tsx';
import type { Equipment } from '../resources/equipment/data.ts';
import { ReservationPanel } from '../resources/equipment/ReservationPanel.tsx';
import { panelRow, scheduleScreen, type Control, type Intent, type ScheduleScreen } from '../resources/equipment/schedule.ts';
import { Timeline, type TimelineControls } from '../resources/equipment/Timeline.tsx';
import { dayHeading, dayInView, stepTo, todayLine } from '../resources/equipment/header.ts';
import { todayInZone } from '../resources/equipment/zone.ts';
import { useEquipmentSchedule } from '../resources/equipment/useEquipmentSchedule.ts';
import { catalogueView } from '../resources/equipment/catalogue.ts';
import { newBookingHref, schedulePrefill } from '../resources/equipment/new-booking.ts';
import { CardButton } from '../threads/cards/Fields.tsx';
import { faces, type } from '../theme/tokens.ts';
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

	const zone = screen.zone, range = state.range;
	// The day in view, from the settled view (today before it settles), and what ‹ and › would show.
	const day = dayInView(state.settled, zone, new Date());
	const today = todayInZone(zone, new Date());
	const top = (c: TimelineControls) => <ScheduleTop controls={c} day={day} today={today} steps={[stepTo(day, c.scale, -1, zone, range), stepTo(day, c.scale, 1, zone, range)]}
		problem={<Problems screen={screen} onPress={schedule.press} />} />;
	return (
		<Screen back={back} list={(frame) => (
			<View style={styles.fill}>
				<Timeline
					state={state} screen={screen} zone={zone} frame={frame} top={top} header={<ScrollHeader screen={screen} onRefresh={schedule.refresh} />} footer={null}
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

/** Prototype frame 5's header, fixed above the timeline so it is in view when the screen opens (H4 contract §3): the
 *  Fraunces heading with Hours / Days / Weeks beside it; the date stepper ‹ day › with "Today is …" (which goes to
 *  today) under the day; the key; "Manage equipment". Then any screen-level problem with its way out. */
function ScheduleTop({ controls, day, today, steps, problem }: { controls: TimelineControls; day: string; today: string;
	steps: readonly [{ at: number } | null, { at: number } | null]; problem: ReactNode }) {
	const styles = useStyles();
	const { colors } = useTheme();
	const step = (i: 0 | 1) => {
		const target = steps[i], weeks = controls.scale === 'weeks', label = i === 0 ? (weeks ? equipmentCopy.previousWeek : equipmentCopy.previousDay) : (weeks ? equipmentCopy.nextWeek : equipmentCopy.nextDay);
		return <Pressable testID={i === 0 ? 'equipment-day-previous' : 'equipment-day-next'} role="button" aria-label={label} aria-disabled={target === null} disabled={target === null}
			accessibilityHint={target === null ? equipmentCopy.stepOutside : undefined} onPress={() => { if (target) controls.focusAt(target.at); }} style={[styles.stepper, target === null && styles.dim]}>
			<View style={i === 0 ? null : styles.flip}><Chevron color={colors.heading} size="large" /></View></Pressable>;
	};
	return (
		<View style={styles.top} testID="equipment-header">
			<View style={styles.titleRow}>
				<Text role="heading" style={styles.title} numberOfLines={1}>{equipmentCopy.heading}</Text>
				<View role="radiogroup" aria-label={equipmentCopy.scale} style={styles.scales}>
					{(['hours', 'days', 'weeks'] as const).map((s) => (
						<Pressable key={s} testID={`equipment-scale-${s}`} role="radio" aria-checked={s === controls.scale} onPress={() => controls.zoom(s)}
							style={[styles.scale, s === controls.scale && styles.scaleOn]}>
							<Text style={[styles.scaleText, s === controls.scale && styles.scaleTextOn]}>{equipmentCopy[s]}</Text>
						</Pressable>
					))}
				</View>
			</View>
			<View style={styles.stepRow}>
				{step(0)}
				<View style={styles.dayBox}>
					<Text testID="equipment-day" role="heading" aria-level={2} style={styles.day} numberOfLines={1}>{dayHeading(day)}</Text>
					<Pressable testID="equipment-today" role="button" aria-label={`${todayLine(today)}. ${equipmentCopy.goToday}`} onPress={controls.today} style={styles.todayButton}>
						<Text style={[styles.todayText, day === today && styles.todayOn]} numberOfLines={1}>{todayLine(today)}</Text>
					</Pressable>
				</View>
				{step(1)}
			</View>
			<View style={styles.keyRow}>
				<View accessible role="list" aria-label={equipmentCopy.key} style={styles.key}>
					<View role="listitem" accessible aria-label={equipmentCopy.keyConfirmed} style={styles.keyItem}><View style={[styles.swatch, styles.swatchBooking]} /><Text style={styles.keyText}>{equipmentCopy.confirmed}</Text></View>
					<View role="listitem" accessible aria-label={equipmentCopy.keyMaintenance} style={styles.keyItem}><View style={[styles.swatch, styles.swatchMaintenance]} /><Text style={styles.keyText}>{equipmentCopy.maintenance}</Text></View>
					<View role="listitem" accessible aria-label={equipmentCopy.keyCleaning} style={styles.keyItem}><View style={[styles.swatch, styles.swatchCleaning]} /><Text style={styles.keyText}>{equipmentCopy.cleaning}</Text></View>
				</View>
			</View>
			{problem}
		</View>
	);
}

/** A problem with the shown schedule, and its way out, under the fixed header. */
function Problems({ screen, onPress }: { screen: ScheduleScreen; onPress: (intent: Intent) => boolean }) {
	const cellRetry = screen.cellRetry, tryAgain = screen.tryAgain;
	if (screen.problem === null && tryAgain === null && cellRetry === null) return null;
	return <View style={{ gap: 8 }}>
		{screen.problem === null ? null : <View testID="equipment-problem"><Notice title={equipmentCopy.heading}>{screen.problem}</Notice></View>}
		{tryAgain === null ? null : <ControlButton testID="equipment-try-again" label={equipmentCopy.tryAgain} control={tryAgain} onPress={() => { onPress(tryAgain.intent); }} />}
		{cellRetry === null ? null : <ControlButton testID="equipment-cells-try-again" label={cellRetry.label} control={cellRetry} onPress={() => { onPress(cellRetry.intent); }} />}
	</View>;
}

/** What scrolls with the timeline, above its names row: the subtitle, the zone, notices, what hatching means and the
 *  archived note. */
function ScrollHeader({ screen, onRefresh }: { screen: ScheduleScreen; onRefresh: () => boolean }) {
	const styles = useStyles();
	return (
		<View style={styles.stack}>
			<View style={styles.actions}>
				<CardButton testID="equipment-manage-open" label={equipmentCopy.manage} onPress={() => router.push('/equipment/manage' as never)} />
				{screen.refresh ? <ControlButton testID="equipment-refresh" label={equipmentCopy.refresh} control={screen.refresh} onPress={() => { onRefresh(); }} /> : null}
			</View>
			<Text testID="equipment-subtitle" style={styles.detail}>{equipmentCopy.subtitle}</Text>
			<Text testID="equipment-zone" style={styles.detail}>{screen.zone ? equipmentTimesIn(screen.zone) : ''}</Text>
			{screen.notices.map((notice) => <Text key={notice} testID="equipment-notice" style={styles.detail}>{notice}</Text>)}
			<Text testID="equipment-legend" style={styles.detail}>{equipmentCopy.legend}</Text>
			<Text testID="equipment-archived" style={styles.detail}>{equipmentCopy.archived}</Text>
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
	// Prototype frame 5, measured at 390 px: the 24 pt Fraunces title beside the 3 pt-padded scale card; the 44 pt stepper
	// squares; the 15/700 day over the 11 pt "Today is"; the 11 pt key with 14 pt swatches.
	top: { paddingHorizontal: 12, paddingBottom: 8, gap: 8, width: '100%', maxWidth: 760, alignSelf: 'center' },
	titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50 },
	title: { flex: 1, minWidth: 0, fontFamily: faces.display, fontSize: 24, lineHeight: 30, color: colors.heading },
	scales: { flexDirection: 'row', padding: 3, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
	scale: { minHeight: 44, minWidth: 48, paddingHorizontal: 10, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
	scaleOn: { backgroundColor: colors.sage },
	scaleText: { fontSize: 12, fontWeight: '700', color: colors.muted },
	scaleTextOn: { color: colors.sageText },
	stepRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	stepper: { width: 44, height: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
	flip: { transform: [{ scaleX: -1 }] },
	dim: { opacity: 0.4 },
	dayBox: { flex: 1, minWidth: 0, alignItems: 'center' },
	day: { fontSize: 15, lineHeight: 19, fontWeight: '700', color: colors.heading },
	// A 44 pt target drawn in the 24 pt line under the day (the margins keep frame 5's spacing).
	todayButton: { minHeight: 44, marginVertical: -10, minWidth: 44, justifyContent: 'center', paddingHorizontal: 6 },
	todayText: { fontSize: 11, lineHeight: 14, color: colors.muted, textDecorationLine: 'underline' },
	todayOn: { textDecorationLine: 'none' },
	keyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 20 },
	key: { flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4, paddingLeft: 2 },
	keyItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
	swatch: { width: 14, height: 12, borderRadius: 3, borderWidth: 1 },
	swatchBooking: { backgroundColor: colors.sage, borderColor: colors.sage, borderLeftWidth: 3, borderLeftColor: colors.action },
	swatchMaintenance: { backgroundColor: colors.card, borderColor: colors.body, borderStyle: 'dashed' },
	swatchCleaning: { backgroundColor: colors.neutral, borderColor: colors.fieldLine },
	keyText: { fontSize: 11, lineHeight: 14, color: colors.muted },
	body: { fontSize: type.body, lineHeight: type.bodyLine, color: colors.body },
	detail: { fontSize: type.label, lineHeight: 17, color: colors.muted }
}));
