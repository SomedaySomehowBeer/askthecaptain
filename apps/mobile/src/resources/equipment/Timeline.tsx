import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	Linking, Pressable, ScrollView, StyleSheet, Text, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent
} from 'react-native';
import { equipmentCellText, equipmentColumnSummary, equipmentCopy, reservationLabel } from '../../account/copy.ts';
import { Button } from '../../components/AccountPage.tsx';
import type { ScreenListFrame } from '../../components/Screen.tsx';
import { colors } from '../../theme/tokens.ts';
import { cellOf, failureOf, reservationsBetween, slotOf, stateBetween, stateOf } from './cells.ts';
import type { Equipment, Reservation } from './data.ts';
import { clampScroll, pixelsAt, scales, zoomScroll, type Scale } from './geometry.ts';
import { chunksBetween, renderWindow, ticks, type ScheduleRange, type TimeWindow } from './range.ts';
import { zoneTime } from './ReservationPanel.tsx';
import { columnWidthFor, offsetFor, settledFrom, type Control, type Intent, type ScheduleScreen, type ScheduleState, type SettledView } from './schedule.ts';

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
export function Timeline({ state, screen, zone, frame, header, footer, onSettle, onScale, onEdge, onToday, onPress, onOpen }: {
	state: ScheduleState; screen: ScheduleScreen; zone: string; frame: ScreenListFrame; header: ReactNode; footer: ReactNode;
	onSettle: (view: SettledView) => void; onScale: (scale: Scale) => void;
	onEdge: (direction: 'earlier' | 'later') => ScheduleRange | null; onToday: () => boolean;
	onPress: (intent: Intent) => void; onOpen: (equipment: Equipment, reservation: Reservation) => void;
}) {
	const range = state.range!, scale = state.scale, ppd = scales[scale];
	const start = Date.parse(range.start), end = Date.parse(range.end);
	const bodyHeight = pixelsAt(end, start, ppd);
	const columns = state.catalogue.columns;

	const vertical = useRef<ScrollView>(null), body = useRef<ScrollView>(null), names = useRef<ScrollView>(null);
	const [columnsWidth, setColumnsWidth] = useState(0);
	const columnWidth = columnWidthFor(columnsWidth || 300);
	const contentWidth = columns.length * columnWidth + columnWidth;
	const layout = useRef({ x: 0, y: 0, viewportHeight: 0, bodyTop: 0, stickyHeight: 0, tail: 0 });
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

	const viewSpan = () => {
		const l = layout.current, { range: r, scale: s } = latest.current;
		return settledFrom({ x: l.x, y: l.y, columnsWidth: latest.current.columnsWidth, columnWidth: latest.current.columnWidth, viewportHeight: l.viewportHeight, bodyTop: l.bodyTop, stickyHeight: l.stickyHeight }, r, s);
	};
	const measured = () => layout.current.viewportHeight > 0 && latest.current.columnsWidth > 0;
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
	/** Applies a pending zoom offset or focus once the layout is measured, then settles explicitly. */
	const applyFocus = () => {
		if (!measured()) return;
		const l = layout.current, { range: r, scale: s, bodyHeight: h } = latest.current;
		const frameSize = { bodyTop: l.bodyTop, stickyHeight: l.stickyHeight, viewportHeight: l.viewportHeight, contentHeight: l.bodyTop + h + l.tail };
		if (pendingY.current !== null) {
			scrollY(clampScroll(pendingY.current, frameSize.contentHeight, l.viewportHeight));
			pendingY.current = null;
		} else if (pendingFocus.current !== null) {
			const focus = pendingFocus.current(r);
			scrollY(offsetFor(focus.at, focus.where, r, s, frameSize));
			pendingFocus.current = null;
		} else return;
		setTimeout(settleNow, 0);
	};

	// A new range (mount, re-anchor, or a zone change on Refresh) is focused; with no explicit focus, on now.
	useEffect(() => {
		if (lastRange.current !== range) {
			if (lastRange.current !== null && pendingFocus.current === null) pendingFocus.current = centreNow;
			lastRange.current = range;
		}
		applyFocus();
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
		layout.current.y = event.nativeEvent.contentOffset.y;
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
	const measure = (key: 'viewportHeight' | 'stickyHeight' | 'tail') => (event: LayoutChangeEvent) => {
		layout.current[key] = event.nativeEvent.layout.height;
		applyFocus();
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
	const step = (direction: -1 | 1) => {
		scrollX(clampScroll(layout.current.x + direction * columnWidth, contentWidth, columnsWidth));
		updateWindows();
		setTimeout(settleNow, 0);
	};
	const atStart = ends.start, atEnd = ends.end || contentWidth <= columnsWidth;

	const shownWindow = rendered ?? { low: start, high: Math.min(end, start + 3 * 86_400_000) };
	const chunkIndexes = chunksBetween(range.chunks, shownWindow.low, shownWindow.high);
	const time = zoneTime(zone);
	let axis: { at: number; label: string }[] = [];
	// The formatters were proven when the zone was accepted (review N3); a failure here renders no labels, never throws.
	try { axis = ticks(scale, range, zone, shownWindow.low, shownWindow.high); } catch { axis = []; }

	return (
		<ScrollView
			ref={vertical} stickyHeaderIndices={[1]} contentContainerStyle={frame.contentContainerStyle}
			onScroll={onVerticalScroll} scrollEventThrottle={32} onMomentumScrollEnd={settleNow} onLayout={measure('viewportHeight')}
		>
			<View style={styles.header}>
				{frame.heading}
				{header}
				<View role="radiogroup" aria-label={equipmentCopy.scale} style={styles.scales}>
					{(['hours', 'days', 'weeks'] as const).map((s) => (
						<Pressable key={s} testID={`equipment-scale-${s}`} role="radio" aria-checked={s === scale} onPress={() => zoom(s)}
							style={[styles.scale, s === scale && styles.scaleOn]}>
							<Text style={[styles.scaleText, s === scale && styles.scaleTextOn]}>{equipmentCopy[s]}</Text>
						</Pressable>
					))}
					<Pressable testID="equipment-today" role="button" onPress={today} style={styles.scale}>
						<Text style={styles.scaleText}>{equipmentCopy.today}</Text>
					</Pressable>
				</View>
			</View>

			<View style={styles.sticky} onLayout={measure('stickyHeight')}>
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
								aria-label={equipmentColumnSummary(equipment.name, equipmentCellText(stateBetween(state.occupancy, equipment.id, range.chunks, shownWindow.low, shownWindow.high), null))}>
								<Text numberOfLines={2} style={styles.nameText}>{equipment.name}</Text>
							</View>
						))}
						<View style={[styles.name, { width: columnWidth }]}><MoreSlot more={screen.more} onPress={onPress} /></View>
					</View>
				</ScrollView>
			</View>

			<View style={styles.edge}>
				{screen.earlier ? <EdgeButton testID="equipment-earlier" label={equipmentCopy.earlier} control={screen.earlier} onPress={() => edge('earlier')} /> : null}
			</View>

			<View style={[styles.bodyRow, { height: bodyHeight }]} onLayout={(event) => { layout.current.bodyTop = event.nativeEvent.layout.y; applyFocus(); }}>
				<View style={[styles.axis, { height: bodyHeight }]}>
					{axis.map((tick) => (
						<Text key={tick.at} style={[styles.tick, { top: pixelsAt(tick.at, start, ppd) }]} numberOfLines={1}>{tick.label}</Text>
					))}
				</View>
				<ScrollView ref={body} horizontal onScroll={onColumnsScroll} scrollEventThrottle={32} onMomentumScrollEnd={settleNow}
					onLayout={(event) => { setColumnsWidth(event.nativeEvent.layout.width); applyFocus(); }} style={styles.fill}>
					<View style={{ width: contentWidth, height: bodyHeight }}>
						{columns.map((equipment, index) => (
							<View key={equipment.id} style={[styles.column, { left: index * columnWidth, width: columnWidth, height: bodyHeight }]}>
								{index < columnSpan[0] || index > columnSpan[1] ? null : (
									<Column state={state} equipment={equipment} chunkIndexes={chunkIndexes} window={shownWindow} start={start} ppd={ppd}
										width={columnWidth} bodyHeight={bodyHeight} time={time} onOpen={onOpen} />
								)}
							</View>
						))}
					</View>
				</ScrollView>
			</View>

			<View style={styles.edge} onLayout={measure('tail')}>
				{screen.later ? <EdgeButton testID="equipment-later" label={equipmentCopy.later} control={screen.later} onPress={() => edge('later')} /> : null}
				{footer}
			</View>
		</ScrollView>
	);
}

/** One rendered column: hatching over every chunk that isn't fully read, and its bars, inside the render window. */
function Column({ state, equipment, chunkIndexes, window, start, ppd, width, bodyHeight, time, onOpen }: {
	state: ScheduleState; equipment: Equipment; chunkIndexes: readonly number[]; window: TimeWindow; start: number; ppd: number;
	width: number; bodyHeight: number; time: (instant: string) => string; onOpen: (equipment: Equipment, reservation: Reservation) => void;
}) {
	const range = state.range!;
	const bars = reservationsBetween(state.occupancy, equipment.id, window.low, window.high);
	return (
		<>
			{chunkIndexes.map((i) => {
				const chunk = range.chunks[i]!, cell = cellOf(state.occupancy, slotOf(equipment.id, chunk)), cellState = stateOf(cell);
				if (cellState === 'complete') return null;
				const low = Math.max(Date.parse(chunk.from), window.low), high = Math.min(Date.parse(chunk.to), window.high);
				if (!(high > low)) return null;
				const top = pixelsAt(low, start, ppd), height = pixelsAt(high, start, ppd) - top;
				const text = equipmentCellText(cellState, failureOf(cell)?.reason ?? null);
				return <Hatch key={chunk.from} top={top} height={height} width={width} text={text} marker={cell?.state === 'marker'} />;
			})}
			{bars.map((r) => {
				const top = Math.max(0, pixelsAt(Date.parse(r.occupiedStartsAt), start, ppd));
				const bottom = Math.min(bodyHeight, pixelsAt(Date.parse(r.occupiedEndsAt), start, ppd));
				const height = Math.max(3, bottom - top);
				const maintenance = r.kind === 'maintenance';
				return (
					<Pressable key={r.id} testID={`equipment-bar-${r.id}`} role="button" aria-label={reservationLabel(equipment.name, r, time)}
						onPress={() => onOpen(equipment, r)}
						style={[styles.bar, maintenance ? styles.maintenance : styles.booking, { top, height }]}>
						{height >= barMinLabel ? <Text numberOfLines={Math.max(1, Math.floor(height / 16))} style={styles.barText}>{r.title}</Text> : null}
					</Pressable>
				);
			})}
		</>
	);
}

/** Not known: a tinted span with a bounded number of diagonal stripes, and the state's words (a marker says the same
 *  words and shows no bars). */
function Hatch({ top, height, width, text, marker }: { top: number; height: number; width: number; text: string; marker: boolean }) {
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

/** The end of the names row (§4.5): More, its own Try again, "Loading more equipment…", or the website notice. */
function MoreSlot({ more, onPress }: { more: ScheduleScreen['more']; onPress: (intent: Intent) => void }) {
	if (more === null) return null;
	if (more.kind !== 'offered' && more.kind !== 'try-again')
		return <Text style={styles.nameText}>{more.kind === 'loading' ? equipmentCopy.moreLoading : equipmentCopy.onWebsite}</Text>;
	const { control, intent } = more;
	return (
		<Pressable testID={`equipment-more-${more.kind}`} role="button" aria-disabled={control.disabled} disabled={control.disabled}
			accessibilityHint={control.reason ?? undefined} onPress={() => onPress(intent)} style={[styles.more, control.disabled && styles.dim]}>
			<Text style={styles.moreText}>{more.kind === 'offered' ? equipmentCopy.more : equipmentCopy.tryAgain}</Text>
			{control.reason ? <Text style={styles.reason}>{control.reason}</Text> : null}
		</Pressable>
	);
}

/** Opens the website schedule (`/resources/equipment`), when this build has its address. */
export function WebLink({ href }: { href: string | null }) {
	if (href === null) return <Text style={styles.reason}>{equipmentCopy.webMissing}</Text>;
	return <Button testID="equipment-web" label={equipmentCopy.openWeb} onPress={() => { void Linking.openURL(href); }} />;
}

const hatchTint = 'rgba(95, 107, 98, 0.10)', stripeTint = 'rgba(95, 107, 98, 0.22)';
const styles = StyleSheet.create({
	fill: { flex: 1 },
	header: { gap: 12, marginBottom: 12 },
	scales: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
	scale: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
	scaleOn: { backgroundColor: colors.selectedPill, borderColor: colors.check },
	scaleText: { fontSize: 14, color: colors.body },
	scaleTextOn: { fontWeight: '600', color: colors.selectedText },
	sticky: { flexDirection: 'row', backgroundColor: colors.page, borderBottomWidth: 1, borderColor: colors.line },
	corner: { width: axisWidth, flexDirection: 'row', alignItems: 'center' },
	arrow: { width: 28, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
	arrowText: { fontSize: 24, color: colors.body },
	dim: { opacity: 0.4 },
	namesRow: { flexDirection: 'row' },
	name: { minHeight: 44, paddingHorizontal: 6, paddingVertical: 4, justifyContent: 'center', borderLeftWidth: 1, borderColor: colors.rowLine },
	nameText: { fontSize: 13, fontWeight: '600', color: colors.heading },
	edge: { gap: 8, marginVertical: 8 },
	bodyRow: { flexDirection: 'row' },
	axis: { width: axisWidth, position: 'relative' },
	tick: { position: 'absolute', left: 0, width: axisWidth - 4, fontSize: 10, color: colors.muted },
	column: { position: 'absolute', top: 0, borderLeftWidth: 1, borderColor: colors.rowLine, overflow: 'hidden' },
	hatch: { position: 'absolute', left: 0, right: 0, overflow: 'hidden', backgroundColor: hatchTint },
	stripe: { position: 'absolute', height: 2, backgroundColor: stripeTint, transform: [{ rotate: '-30deg' }] },
	hatchText: { margin: 4, fontSize: 11, lineHeight: 14, color: colors.muted },
	bar: { position: 'absolute', left: 3, right: 3, borderRadius: 6, borderWidth: 1, paddingHorizontal: 4, overflow: 'hidden' },
	booking: { backgroundColor: colors.sage, borderColor: colors.sea },
	maintenance: { backgroundColor: colors.card, borderColor: colors.body, borderWidth: 2, borderStyle: 'dashed' },
	barText: { fontSize: 12, lineHeight: 16, color: colors.heading },
	more: { minHeight: 44, justifyContent: 'center' },
	moreText: { fontSize: 13, fontWeight: '600', color: colors.sea },
	reason: { fontSize: 12, lineHeight: 16, color: colors.muted }
});
