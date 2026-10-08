import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import {
	Pressable, ScrollView, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent
} from 'react-native';
import { equipmentCellText, equipmentColumnSummary, equipmentCopy, reservationLabel } from '../../account/copy.ts';
import { Button } from '../../components/AccountPage.tsx';
import type { ScreenListFrame } from '../../components/Screen.tsx';
import { themedStyles } from '../../theme/theme.ts';
import { cellOf, failureOf, reservationsBetween, slotOf, stateBetween, stateOf } from './cells.ts';
import type { Equipment, Reservation } from './data.ts';
import { clampScroll, pixelsAt, scales, zoomScroll, type Scale } from './geometry.ts';
import { chunksBetween, renderWindow, ticks, type ScheduleRange, type TimeWindow } from './range.ts';
import { zoneTime } from './ReservationPanel.tsx';
import { wordInstant } from '../../threads/wording.ts';
import {
	columnWidthFor, focusMissed, focusReady, layoutMeasured, offsetFor, settledFrom, type Control, type Intent, type Measured, type ScheduleScreen,
	type ScheduleState, type SettledView
} from './schedule.ts';

const axisWidth = 56;
/** The idle settle (design revision 2): planning happens this long after the last scroll event, on every platform. */
const idleSettleMs = 200;
const barMinLabel = 20;

type Focus = (range: ScheduleRange) => { readonly at: number; readonly where: 'centre' | 'top' | 'bottom' };
const centreNow: Focus = () => ({ at: Date.now(), where: 'centre' });

/** The schedule's one vertical scroll (contract §5): the header block, the sticky row of equipment names with the
 *  column arrows, "Earlier dates", the body (a fixed time axis beside the columns' horizontal ScrollView), then
 *  "Later dates" and the footer. Only the visible time plus 1.5 viewports is rendered.
 *
 *  Occupancy is planned only at a settle: the idle timer after scrolling stops, the native end events, and an explicit
 *  settle after every programmatic scroll (arrows, Today, zoom, re-anchor, the first scroll to now, and the clamp after
 *  a list replacement). The geometry sent holds no equipment IDs. */
/** What the fixed header above the timeline (H4, prototype frame 5) drives: the scale, Today, and a jump to an instant. */
export type TimelineControls = { readonly scale: Scale; zoom(next: Scale): void; today(): void; focusAt(at: number): void };

export function Timeline({ state, screen, zone, frame, top, header, footer, onSettle, onScale, onEdge, onToday, onPress, onOpen }: {
	state: ScheduleState; screen: ScheduleScreen; zone: string; frame: ScreenListFrame; header: ReactNode; footer: ReactNode;
	/** The header that stays put above the scrolling timeline: the heading, the scales, the date stepper and the key. */
	top: (controls: TimelineControls) => ReactNode;
	onSettle: (view: SettledView) => void; onScale: (scale: Scale) => void;
	onEdge: (direction: 'earlier' | 'later') => ScheduleRange | null; onToday: () => boolean;
	onPress: (intent: Intent) => void; onOpen: (equipment: Equipment, reservation: Reservation) => void;
}) {
	const styles = useStyles();
	const range = state.range!, scale = state.scale, ppd = scales[scale];
	const start = Date.parse(range.start), end = Date.parse(range.end);
	const bodyHeight = pixelsAt(end, start, ppd);
	const columns = state.catalogue.columns;

	const vertical = useRef<ScrollView>(null), body = useRef<ScrollView>(null), names = useRef<ScrollView>(null);
	const [columnsWidth, setColumnsWidth] = useState(0);
	const columnWidth = columnWidthFor(columnsWidth || 300);
	const contentWidth = columns.length * columnWidth + columnWidth;
	const layout = useRef({ x: 0, y: 0, viewportHeight: 0, bodyTop: 0, stickyHeight: 0, contentHeight: 0 });
	// The latest values for callbacks and timers.
	const latest = useRef({ range, scale, columnWidth, columnsWidth, contentWidth, bodyHeight, onSettle });
	latest.current = { range, scale, columnWidth, columnsWidth, contentWidth, bodyHeight, onSettle };

	const [rendered, setRendered] = useState<TimeWindow | null>(null);
	const [columnSpan, setColumnSpan] = useState<readonly [number, number]>([0, 4]);
	const [ends, setEnds] = useState<{ start: boolean; end: boolean }>({ start: true, end: false });
	const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingFocus = useRef<Focus | null>(centreNow);
	const pendingY = useRef<number | null>(null);
	const lastRange = useRef<ScheduleRange | null>(null);
	/** The last focus scroll issued and not yet confirmed by the ScrollView; re-issued at most once. */
	const issued = useRef<{ target: number; retried: boolean } | null>(null);

	const viewSpan = () => {
		const l = layout.current, { range: r, scale: s } = latest.current;
		return settledFrom({ x: l.x, y: l.y, columnsWidth: latest.current.columnsWidth, columnWidth: latest.current.columnWidth, viewportHeight: l.viewportHeight, bodyTop: l.bodyTop, stickyHeight: l.stickyHeight }, r, s);
	};
	const sizes = (): Measured => ({ viewportHeight: layout.current.viewportHeight, columnsWidth: latest.current.columnsWidth, bodyTop: layout.current.bodyTop, contentHeight: layout.current.contentHeight });
	// A settle needs the body row placed too (A's note 4): an early settle with bodyTop 0 would plan the wrong dates.
	const measured = () => layoutMeasured(sizes());
	const updateWindows = () => {
		if (!measured()) return;
		const v = viewSpan(), r = latest.current.range;
		setRendered((current) => renderWindow(current, v.low, v.high, Date.parse(r.start), Date.parse(r.end)));
		const w = latest.current.columnWidth, width = latest.current.columnsWidth, x = layout.current.x;
		const first = Math.max(0, Math.floor((x - width) / w)), last = Math.ceil((x + 2 * width) / w);
		setColumnSpan((current) => (current[0] === first && current[1] === last ? current : [first, last]));
		const atStart = x <= 0, atEnd = x >= Math.max(0, latest.current.contentWidth - width) - 1;
		setEnds((current) => (current.start === atStart && current.end === atEnd ? current : { start: atStart, end: atEnd }));
	};
	const settleNow = () => {
		if (idle.current !== null) { clearTimeout(idle.current); idle.current = null; }
		if (!measured()) return;
		updateWindows();
		latest.current.onSettle(viewSpan());
	};
	const settleSoon = () => {
		if (idle.current !== null) clearTimeout(idle.current);
		idle.current = setTimeout(settleNow, idleSettleMs);
	};
	useEffect(() => () => { if (idle.current !== null) clearTimeout(idle.current); }, []);

	const scrollY = (y: number) => {
		layout.current.y = y;
		vertical.current?.scrollTo({ y, animated: false });
	};
	const scrollX = (x: number) => {
		layout.current.x = x;
		body.current?.scrollTo({ x, animated: false });
		names.current?.scrollTo({ x, animated: false });
	};
	const focusPending = () => pendingY.current !== null || pendingFocus.current !== null;
	/** Applies a pending zoom offset or focus, but only once the scroll can take effect (`focusReady`: measured, and the
	 *  content laid out taller than the viewport). Until then the focus stays pending; it is consumed only by a scroll
	 *  that can land. Then it settles explicitly. Safe to call from any layout event, in any order. */
	const applyFocus = () => {
		if (!focusPending() || !focusReady(sizes())) return;
		const l = layout.current, { range: r, scale: s } = latest.current;
		const frameSize = { bodyTop: l.bodyTop, stickyHeight: l.stickyHeight, viewportHeight: l.viewportHeight, contentHeight: l.contentHeight };
		let target: number;
		if (pendingY.current !== null) target = clampScroll(pendingY.current, l.contentHeight, l.viewportHeight);
		else {
			const focus = pendingFocus.current!(r);
			target = offsetFor(focus.at, focus.where, r, s, frameSize);
		}
		pendingY.current = null;
		pendingFocus.current = null;
		issued.current = { target, retried: false };
		scrollY(target);
		setTimeout(settleNow, 0);
	};
	/** The ScrollView's next report after a focus: confirmed if it landed; otherwise the focus is issued once more. */
	const checkFocus = (reported: number | null) => {
		const last = issued.current;
		if (last === null) return;
		if (reported !== null && !focusMissed(last.target, reported)) { issued.current = null; return; }
		if (last.retried) { issued.current = null; return; }
		issued.current = { target: last.target, retried: true };
		scrollY(last.target);
		setTimeout(settleNow, 0);
	};
	/** After any measurement: apply a pending focus, re-check the last one, or, with nothing pending, settle soon. The
	 *  first settle therefore happens whichever layout event arrives last. */
	const measuredAgain = () => {
		if (focusPending()) { applyFocus(); return; }
		checkFocus(null);
		settleSoon();
	};

	// A new range (mount, re-anchor, or a zone change on Refresh) is focused; with no explicit focus, on now.
	useEffect(() => {
		if (lastRange.current !== range) {
			if (lastRange.current !== null && pendingFocus.current === null) pendingFocus.current = centreNow;
			lastRange.current = range;
		}
		// The columns' width reaches `latest` only on this render, so a width measurement lands here.
		measuredAgain();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [range, scale, columnsWidth]);
	// A replaced or longer list: keep x inside the content (design E1), then settle so new columns can be planned.
	useEffect(() => {
		const maxX = Math.max(0, contentWidth - columnsWidth);
		if (layout.current.x > maxX) scrollX(maxX);
		settleNow();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [columns]);

	const onVerticalScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
		const y = event.nativeEvent.contentOffset.y;
		if (issued.current !== null) {
			checkFocus(y);
			if (issued.current !== null) return; // re-issued: the reported offset was not the focus
		}
		layout.current.y = y;
		updateWindows();
		settleSoon();
	};
	const onColumnsScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
		const x = event.nativeEvent.contentOffset.x;
		layout.current.x = x;
		names.current?.scrollTo({ x, animated: false });
		updateWindows();
		settleSoon();
	};
	const measure = (key: 'viewportHeight' | 'stickyHeight') => (event: LayoutChangeEvent) => {
		layout.current[key] = event.nativeEvent.layout.height;
		measuredAgain();
	};

	const zoom = (next: Scale) => {
		if (next === scale) return;
		const l = layout.current;
		pendingY.current = zoomScroll(l.y, l.viewportHeight / 2, scales[scale], scales[next], l.bodyTop);
		onScale(next);
	};
	const edge = (direction: 'earlier' | 'later') => {
		const moved = onEdge(direction);
		if (moved !== null) pendingFocus.current = (r) => ({ at: Date.parse(r.anchorAt), where: direction === 'earlier' ? 'top' : 'bottom' });
	};
	const today = () => {
		if (!onToday()) return;
		pendingFocus.current = centreNow;
		applyFocus();
	};
	/** The date stepper: the middle of the view moves to `at` (a day's midday), then settles. */
	const focusAt = (at: number) => {
		pendingFocus.current = () => ({ at, where: 'centre' });
		applyFocus();
	};
	const step = (direction: -1 | 1) => {
		scrollX(clampScroll(layout.current.x + direction * columnWidth, contentWidth, columnsWidth));
		updateWindows();
		setTimeout(settleNow, 0);
	};
	const atStart = ends.start, atEnd = ends.end || contentWidth <= columnsWidth;

	const shownWindow = rendered ?? { low: start, high: Math.min(end, start + 3 * 86_400_000) };
	const chunkIndexes = chunksBetween(range.chunks, shownWindow.low, shownWindow.high);
	const time = zoneTime(zone);
	// Each column's summary covers the settled visible dates (§5), not the wider render window (A's note 2). Before a
	// view has settled it claims no state at all: the name only.
	const settled = state.settled;
	const columnLabel = (equipment: Equipment) => settled === null ? equipment.name
		: equipmentColumnSummary(equipment.name, equipmentCellText(stateBetween(state.occupancy, equipment.id, range.chunks, settled.low, settled.high), null));
	let axis: { at: number; label: string }[] = [];
	// The formatters were proven when the zone was accepted (review N3); a failure here renders no labels, never throws.
	try { axis = ticks(scale, range, zone, shownWindow.low, shownWindow.high); } catch { axis = []; }

	return (
		<View style={styles.fill}>
		{top({ scale, zoom, today, focusAt })}
		<ScrollView
			ref={vertical} stickyHeaderIndices={[1]} contentContainerStyle={frame.contentContainerStyle}
			onScroll={onVerticalScroll} scrollEventThrottle={32} onMomentumScrollEnd={settleNow} onLayout={measure('viewportHeight')}
			onContentSizeChange={(_width, height) => { layout.current.contentHeight = height; measuredAgain(); }}
		>
			<View style={styles.header}>
				{frame.heading}
				{header}
			</View>

			{/* The page colour behind the names row's rounded corners, so nothing scrolling under it shows through them. */}
			<View style={styles.stickyBack} onLayout={measure('stickyHeight')}><View style={styles.sticky}>
				<View style={styles.corner}>
					<Pressable testID="equipment-previous" role="button" aria-label={equipmentCopy.previousColumn} aria-disabled={atStart} disabled={atStart}
						onPress={() => step(-1)} hitSlop={6} style={[styles.arrow, atStart && styles.dim]}><Text style={styles.arrowText}>‹</Text></Pressable>
					<Pressable testID="equipment-next" role="button" aria-label={equipmentCopy.nextColumn} aria-disabled={atEnd} disabled={atEnd}
						onPress={() => step(1)} hitSlop={6} style={[styles.arrow, atEnd && styles.dim]}><Text style={styles.arrowText}>›</Text></Pressable>
				</View>
				<ScrollView ref={names} horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false} style={styles.fill}>
					<View style={[styles.namesRow, { width: contentWidth }]}>
						{columns.map((equipment) => (
							<View key={equipment.id} accessible role="columnheader" style={[styles.name, { width: columnWidth }]}
								aria-label={columnLabel(equipment)}>
								<Text numberOfLines={2} style={styles.nameText}>{equipment.name}</Text>
							</View>
						))}
						<View style={[styles.name, { width: columnWidth }]}><MoreSlot more={screen.more} onPress={onPress} /></View>
					</View>
				</ScrollView>
			</View></View>

			<View style={styles.edge}>
				{screen.earlier ? <EdgeButton testID="equipment-earlier" label={equipmentCopy.earlier} control={screen.earlier} onPress={() => edge('earlier')} /> : null}
			</View>

			<View style={[styles.bodyRow, { height: bodyHeight }]} onLayout={(event) => { layout.current.bodyTop = event.nativeEvent.layout.y; measuredAgain(); }}>
				<View style={[styles.axis, { height: bodyHeight }]}>
					{axis.map((tick) => (
						<Text key={tick.at} style={[styles.tick, { top: pixelsAt(tick.at, start, ppd) }]} numberOfLines={1}>{tick.label}</Text>
					))}
				</View>
				<ScrollView ref={body} horizontal onScroll={onColumnsScroll} scrollEventThrottle={32} onMomentumScrollEnd={settleNow}
					onLayout={(event) => { setColumnsWidth(event.nativeEvent.layout.width); }} style={styles.fill}>
					<View style={{ width: contentWidth, height: bodyHeight }}>
						{columns.map((equipment, index) => (
							<View key={equipment.id} style={[styles.column, { left: index * columnWidth, width: columnWidth, height: bodyHeight }]}>
								{index < columnSpan[0] || index > columnSpan[1] ? null : (
									<Column state={state} equipment={equipment} chunkIndexes={chunkIndexes} window={shownWindow} start={start} ppd={ppd}
										width={columnWidth} bodyHeight={bodyHeight} time={time} zone={zone} onOpen={onOpen} />
								)}
							</View>
						))}
					</View>
				</ScrollView>
			</View>

			<View style={styles.edge}>
				{screen.later ? <EdgeButton testID="equipment-later" label={equipmentCopy.later} control={screen.later} onPress={() => edge('later')} /> : null}
				{footer}
			</View>
		</ScrollView>
		</View>
	);
}

/** One rendered column, inside the render window. The column's own base is the "not known" tint (review S1), so time
 *  not rendered yet (render lag, a fast fling, a column outside the rendered span) can only look hatched. A fully read
 *  chunk is painted over with an opaque page-colour block, the only place blank time appears; every other chunk gets
 *  stripes and its words. Bars are drawn last, over both. */
function Column({ state, equipment, chunkIndexes, window, start, ppd, width, bodyHeight, time, zone, onOpen }: {
	state: ScheduleState; zone: string; equipment: Equipment; chunkIndexes: readonly number[]; window: TimeWindow; start: number; ppd: number;
	width: number; bodyHeight: number; time: (instant: string) => string; onOpen: (equipment: Equipment, reservation: Reservation) => void;
}) {
	const styles = useStyles();
	const range = state.range!;
	const bars = reservationsBetween(state.occupancy, equipment.id, window.low, window.high);
	const clock = (at: string) => wordInstant(at, zone)?.time ?? '';
	return (
		<>
			{chunkIndexes.map((i) => {
				const chunk = range.chunks[i]!, cell = cellOf(state.occupancy, slotOf(equipment.id, chunk)), cellState = stateOf(cell);
				const low = Math.max(Date.parse(chunk.from), window.low), high = Math.min(Date.parse(chunk.to), window.high);
				if (!(high > low)) return null;
				const top = pixelsAt(low, start, ppd), height = pixelsAt(high, start, ppd) - top;
				if (cellState === 'complete') return <View key={chunk.from} testID="equipment-read" style={[styles.read, { top, height }]} pointerEvents="none" />;
				const text = equipmentCellText(cellState, failureOf(cell)?.reason ?? null);
				return <Hatch key={chunk.from} top={top} height={height} width={width} text={text} marker={cell?.state === 'marker'} />;
			})}
			{bars.map((r) => {
				// Frame 5: the booking's own time is the bar; setup before it and cleaning after it are their own hatched blocks.
				const y = (at: string) => Math.min(bodyHeight, Math.max(0, pixelsAt(Date.parse(at), start, ppd)));
				const top = y(r.startsAt), height = Math.max(3, y(r.endsAt) - top);
				const setup = y(r.startsAt) - y(r.occupiedStartsAt), cleanup = y(r.occupiedEndsAt) - y(r.endsAt);
				const maintenance = r.kind === 'maintenance';
				const lines = Math.max(1, Math.floor((height - 6) / 15));
				return (
					<Fragment key={r.id}>
						{setup >= 1 ? <View testID="equipment-setup" pointerEvents="none" style={[styles.extra, { top: y(r.occupiedStartsAt), height: setup }]}>
							{setup >= barMinLabel ? <Text numberOfLines={Math.max(1, Math.floor((setup - 4) / 14))} style={styles.extraText}>{equipmentCopy.setup}<Text style={styles.extraTime}>{setup >= 34 ? `\nfrom ${clock(r.occupiedStartsAt)}` : ''}</Text></Text> : null}</View> : null}
						<Pressable testID={`equipment-bar-${r.id}`} role="button" aria-label={reservationLabel(equipment.name, r, time)}
							onPress={() => onOpen(equipment, r)}
							style={[styles.bar, maintenance ? styles.maintenance : styles.booking, { top, height }]}>
							{height >= barMinLabel ? <Text numberOfLines={Math.min(lines, 3)} style={styles.barText}>{r.title}</Text> : null}
							{lines >= 2 ? <Text numberOfLines={lines - 1} style={styles.barTime}>{`${clock(r.startsAt)} to ${clock(r.endsAt)}`}</Text> : null}
						</Pressable>
						{cleanup >= 1 ? <View testID="equipment-cleanup" pointerEvents="none" style={[styles.extra, { top: y(r.endsAt), height: cleanup }]}>
							{cleanup >= barMinLabel ? <Text numberOfLines={Math.max(1, Math.floor((cleanup - 4) / 14))} style={styles.extraText}>{equipmentCopy.cleaning}<Text style={styles.extraTime}>{cleanup >= 34 ? `\nto ${clock(r.occupiedEndsAt)}` : ''}</Text></Text> : null}</View> : null}
					</Fragment>
				);
			})}
		</>
	);
}

/** Not known: a tinted span with a bounded number of diagonal stripes, and the state's words (a marker says the same
 *  words and shows no bars). */
function Hatch({ top, height, width, text, marker }: { top: number; height: number; width: number; text: string; marker: boolean }) {
	const styles = useStyles();
	const spacing = Math.max(16, height / 40), count = Math.ceil(height / spacing);
	return (
		<View testID={marker ? 'equipment-marker' : 'equipment-hatch'} style={[styles.hatch, { top, height }]} pointerEvents="none">
			{Array.from({ length: count }, (_, i) => (
				<View key={i} style={[styles.stripe, { top: i * spacing, left: -width, width: width * 3 }]} />
			))}
			{height > 36 ? <Text numberOfLines={2} style={styles.hatchText}>{text}</Text> : null}
		</View>
	);
}

function EdgeButton({ testID, label, control, onPress }: { testID: string; label: string; control: Control; onPress: () => void }) {
	return <Button testID={testID} label={label} disabled={control.disabled} reason={control.reason} onPress={onPress} />;
}

/** The end of the names row (§4.5): More, its own Try again, "Loading more equipment…", or the ceiling notice. */
function MoreSlot({ more, onPress }: { more: ScheduleScreen['more']; onPress: (intent: Intent) => void }) {
	const styles = useStyles();
	if (more === null) return null;
	if (more.kind !== 'offered' && more.kind !== 'try-again') {
		if (more.kind === 'loading') return <Text style={styles.nameText}>{equipmentCopy.moreLoading}</Text>;
		return <Text testID="equipment-ceiling" style={styles.nameText}>{equipmentCopy.ceiling}</Text>;
	}
	const { control, intent } = more;
	return (
		<Pressable testID={`equipment-more-${more.kind}`} role="button" aria-disabled={control.disabled} disabled={control.disabled}
			accessibilityHint={control.reason ?? undefined} onPress={() => onPress(intent)} style={[styles.more, control.disabled && styles.dim]}>
			<Text style={styles.moreText}>{more.kind === 'offered' ? equipmentCopy.more : equipmentCopy.tryAgain}</Text>
			{control.reason ? <Text style={styles.reason}>{control.reason}</Text> : null}
		</Pressable>
	);
}

const useStyles = themedStyles((colors) => ({
	fill: { flex: 1 },
	header: { gap: 12, marginBottom: 12 },
	// Prototype frame 5: Hours, Days and Weeks as one segmented card; the chosen scale on sage.
	scales: { flexDirection: 'row', flexWrap: 'wrap', gap: 0, padding: 3, alignSelf: 'flex-start', borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
	scale: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
	scaleOn: { backgroundColor: colors.sage },
	scaleText: { fontSize: 12, fontWeight: '700', color: colors.muted },
	scaleTextOn: { color: colors.sageText },
	stickyBack: { backgroundColor: colors.page },
	sticky: { flexDirection: 'row', backgroundColor: colors.pinned, borderBottomWidth: 1, borderColor: colors.line, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
	corner: { width: axisWidth, flexDirection: 'row', alignItems: 'center' },
	arrow: { width: 28, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
	arrowText: { fontSize: 24, color: colors.body },
	dim: { opacity: 0.4 },
	namesRow: { flexDirection: 'row' },
	name: { minHeight: 44, paddingHorizontal: 6, paddingVertical: 4, justifyContent: 'center', borderLeftWidth: 1, borderColor: colors.rowLine },
	nameText: { fontSize: 11, lineHeight: 15, fontWeight: '700', color: colors.heading, textAlign: 'center' },
	edge: { gap: 8, marginVertical: 8 },
	bodyRow: { flexDirection: 'row' },
	axis: { width: axisWidth, position: 'relative' },
	tick: { position: 'absolute', left: 0, width: axisWidth - 4, fontSize: 10, lineHeight: 13, color: colors.muted },
	// The base of every column is "not known"; only a painted, fully read block is page colour (review S1).
	column: { position: 'absolute', top: 0, borderLeftWidth: 1, borderColor: colors.rowLine, overflow: 'hidden', backgroundColor: colors.unknown },
	read: { position: 'absolute', left: 0, right: 0, backgroundColor: colors.page },
	hatch: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
	stripe: { position: 'absolute', height: 2, backgroundColor: colors.unknownStripe, transform: [{ rotate: '-30deg' }] },
	hatchText: { margin: 4, fontSize: 11, lineHeight: 14, color: colors.muted },
	bar: { position: 'absolute', left: 3, right: 3, borderRadius: 8, borderWidth: 1, borderLeftWidth: 3, paddingHorizontal: 6, overflow: 'hidden' },
	booking: { backgroundColor: colors.sage, borderColor: colors.sage, borderLeftColor: colors.action },
	maintenance: { backgroundColor: colors.card, borderColor: colors.body, borderWidth: 1, borderLeftWidth: 1, borderStyle: 'dashed' },
	barText: { fontSize: 11, lineHeight: 15, fontWeight: '700', color: colors.heading, paddingTop: 3 },
	barTime: { fontSize: 10, lineHeight: 14, color: colors.body },
	// Frame 5's "Cleaning": a pale, hatched-looking block under the booking (a dashed outline; no image or gesture library).
	extra: { position: 'absolute', left: 3, right: 3, borderRadius: 8, borderWidth: 1, borderColor: colors.fieldLine, backgroundColor: colors.neutral, paddingHorizontal: 6, overflow: 'hidden' },
	extraText: { fontSize: 10, lineHeight: 14, fontWeight: '700', color: colors.neutralText, paddingTop: 3 },
	extraTime: { fontWeight: '400' },
	more: { minHeight: 44, justifyContent: 'center' },
	moreText: { fontSize: 12, fontWeight: '700', color: colors.action },
	reason: { fontSize: 12, lineHeight: 16, color: colors.muted }
}));
