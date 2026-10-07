/** History (design boards 5, 6 and 11): a record's change sets, newest first, each change worded as its change line, with
 *  its state; tick boxes on what can be undone; the bar once anything is ticked; earlier pages by cursor; and the row that
 *  says when history starts, with the record as it was then. The preview sheet is PreviewSheet.tsx. Presentation over
 *  the controller: it owns every request. */
import { createElement, useEffect, useRef, type ReactNode } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Lock, Undone } from '../../components/Icons.tsx';
import { themedStyles, useTheme } from '../../theme/theme.ts';
import { familyFor, space, type } from '../../theme/tokens.ts';
import { CardButton, Note } from '../cards/Fields.tsx';
import type { Segment } from '../wording.ts';
import type { ChangeSet, Entry } from './contracts.ts';
import type { HistoryController, HistoryState } from './controller.ts';
import { isTickable } from './controller.ts';
import { historyCopy, ticked } from './copy.ts';
import { actorInitials, actorName, entrySentence, plainText, setTime, startWords, stateWords, versionLines, type HistoryWords } from './words.ts';

const web = Platform.OS === 'web';
/** The body face, so the browser's own label matches the text around it. */
const textFont = familyFor('regular', true);

export function HistoryList({ state, controller, words, focus, heading, contentStyle }: {
	state: HistoryState; controller: HistoryController; words: HistoryWords; focus: string | null; heading: ReactNode; contentStyle: unknown;
}) {
	const styles = useStyles();
	const scroll = useRef<ScrollView>(null);
	const positions = useRef(new Map<string, number>());
	const scrolled = useRef(false);
	const kind = state.target?.kind ?? 'task';
	// Opened from a change line: bring its change set into view once it has loaded (a few earlier pages at most).
	useEffect(() => {
		if (!focus || scrolled.current || state.phase !== 'ready') return;
		if (!state.sets.some((s) => s.id === focus)) { if (state.nextCursor && !state.loadingMore && state.sets.length < 100) void controller.more(); return; }
		const y = positions.current.get(focus);
		if (y !== undefined) { scrolled.current = true; scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: false }); }
	}, [focus, state.phase, state.sets, state.loadingMore]);

	if (state.version) return <ScrollView contentContainerStyle={contentStyle as never}>{heading}<VersionPanel state={state} controller={controller} words={words} /></ScrollView>;
	return <ScrollView ref={scroll} testID="history-scroll" contentContainerStyle={contentStyle as never}>
		{heading}
		<Text style={styles.sub}>{historyCopy.sub}</Text>
		<View style={styles.list}>
			{state.notice ? <View testID="history-notice" role="status" style={[styles.note, styles.noteOk]}><Text aria-hidden style={styles.tick}>✓</Text><Text style={styles.noteText}><Text style={styles.strong}>{state.notice}</Text> The thread shows it as a change too.</Text></View> : null}
			{state.recovered ? <View testID="history-recovered" style={styles.recovered}>
				<Note tone="warn">{state.recoveredMessage || historyCopy.recovered}</Note>
				<View style={styles.row}>
					<CardButton testID="history-recovered-retry" label="Undo again with the same change ID" display="Undo again" primary grow disabled={state.recoveredBusy} onPress={() => { void controller.retryRecovered(); }} />
					<CardButton testID="history-recovered-check" label="Check History for it" display="Check" disabled={state.recoveredBusy} onPress={controller.check} />
					<CardButton testID="history-recovered-forget" label="Forget this undo" display="Forget" disabled={state.recoveredBusy} onPress={controller.forgetRecovered} />
				</View>
			</View> : null}
			{state.message ? <View style={styles.row}><Text testID="history-status" role="status" style={[styles.muted, { flex: 1 }]}>{state.message}</Text>
				{state.phase === 'failed' || state.message === historyCopy.failed ? <CardButton testID="history-retry" label="Try again" onPress={() => { void controller.load(); }} /> : null}</View> : null}
			{state.phase === 'loading' || state.phase === 'idle' ? <Text testID="history-loading" style={styles.muted}>{historyCopy.loading}</Text> : null}
			{state.phase === 'ready' && !state.sets.length ? <Text testID="history-empty" style={styles.muted}>{historyCopy.empty}</Text> : null}
			{state.sets.map((set) => <View key={set.id} onLayout={(e) => { positions.current.set(set.id, e.nativeEvent.layout.y); }}>
				<SetCard set={set} state={state} controller={controller} words={words} focused={set.id === focus} />
			</View>)}
			{state.nextCursor ? <CardButton testID="history-earlier" label={state.loadingMore ? historyCopy.loadingEarlier : historyCopy.earlier} quiet disabled={state.loadingMore} onPress={() => { void controller.more(); }} /> : null}
			{state.start && state.phase === 'ready' ? (() => { const s = startWords(state.start, kind, words); return <View testID="history-start" style={styles.startRow}>
				<Text style={styles.muted}>{s.text}</Text>
				<Pressable testID="history-start-link" role="link" aria-label={s.link} onPress={() => { void controller.openVersion(state.start!.revision); }} style={styles.linkBox}><Text style={[styles.muted, styles.link]}>{s.link}</Text></Pressable>
			</View>; })() : null}
		</View>
	</ScrollView>;
}

function SetCard({ set, state, controller, words, focused }: { set: ChangeSet; state: HistoryState; controller: HistoryController; words: HistoryWords; focused: boolean }) {
	const styles = useStyles();
	return <View testID={`history-set-${set.id}`} role="group" aria-label={`${actorName(set.actor)}, ${setTime(set.createdAt, words)}${set.causeKind === 'reversal' ? ', undo' : ''}`} style={[styles.set, focused && styles.setFocused]}>
		<View style={styles.setHead}>
			<View aria-hidden style={styles.avatar}><Text style={styles.initials}>{actorInitials(set.actor)}</Text></View>
			<Text style={styles.setWho}><Text style={styles.strong}>{actorName(set.actor)}</Text> · {setTime(set.createdAt, words)}{set.causeKind === 'reversal' ? ' · Undo' : ''}</Text>
		</View>
		{set.changes.map((entry, i) => <ChangeRow key={entry.id} entry={entry} set={set} state={state} controller={controller} words={words} last={i === set.changes.length - 1} />)}
	</View>;
}

function Words({ segments }: { segments: readonly Segment[] }) {
	const styles = useStyles();
	// History words its values plainly (R3 History.dc.html); a change line in the thread sets them in bold.
	return <>{segments.map((s) => s.text).join('')}</>;
}

function ChangeRow({ entry, set, state, controller, words, last }: { entry: Entry; set: ChangeSet; state: HistoryState; controller: HistoryController; words: HistoryWords; last: boolean }) {
	const styles = useStyles();
	const { colors } = useTheme();
	const sentence = entrySentence(entry, set, state.names, { ...words, names: { ...controller.loadedNames(), ...words.names } });
	const { badge, note } = stateWords(entry, words);
	const tickable = isTickable(entry);
	const checked = tickable && entry.changeIds.every((id) => state.selected.includes(id));
	const disabled = Boolean(state.sheet);
	const label = `${plainText(sentence)}${badge ? `. ${badge}` : ''}${note ? `. ${note}` : ''}`;
	const body = <View style={styles.chgText}>
		<Text style={styles.chgWords}><Words segments={sentence} /></Text>
		{note ? <Text testID={`history-note-${entry.id}`} style={styles.chgNote}>{note}</Text> : null}
	</View>;
	const badgeView = badge ? <Text testID={`history-badge-${entry.id}`} style={[styles.badge, badge === 'Changed since' ? styles.badgeWarn : badge === 'Undone' ? styles.badgeDone : styles.badgeOff]}>{badge}</Text> : null;
	const rowStyle = [styles.chg, last && styles.chgLast, checked && styles.picked];
	if (!tickable) return <View testID={`history-entry-${entry.id}`} accessible focusable aria-label={label} style={rowStyle}>
		<View style={styles.glyph}>{entry.state === 'reversed' ? <Undone color={colors.muted} /> : <Lock color={colors.muted} />}</View>{body}{badgeView}</View>;
	if (web) return <View testID={`history-entry-${entry.id}`} style={[rowStyle, styles.chgWeb]}>{createElement('label', { style: { display: 'flex', alignItems: 'flex-start', gap: 10, flex: 1, minWidth: 0, minHeight: 44, padding: '11px 12px', boxSizing: 'border-box', cursor: disabled ? 'default' : 'pointer', fontFamily: textFont } },
		createElement('input', { type: 'checkbox', 'data-testid': `history-tick-${entry.id}`, 'aria-label': label, checked, disabled, onChange: () => controller.toggle(entry),
			style: { width: 20, height: 20, margin: 0, marginTop: 1, accentColor: colors.action, flex: 'none' } }), body, badgeView)}</View>;
	return <Pressable testID={`history-tick-${entry.id}`} role="checkbox" aria-checked={checked} aria-label={label} aria-disabled={disabled} disabled={disabled} onPress={() => controller.toggle(entry)} style={rowStyle}>
		<View aria-hidden style={[styles.box, checked && styles.boxOn]}>{checked ? <Text style={styles.boxTick}>✓</Text> : null}</View>{body}{badgeView}</Pressable>;
}

/** Board 6: the bar once anything is ticked. */
export function TickBar({ state, controller }: { state: HistoryState; controller: HistoryController }) {
	const styles = useStyles();
	if (!state.selected.length || state.sheet || state.version || state.phase !== 'ready') return null;
	const index = new Map(state.sets.flatMap((s) => s.changes.map((c) => [c.id, c] as const)));
	const count = [...index.values()].filter((c) => c.changeIds.every((id) => state.selected.includes(id))).length || state.selected.length;
	return <View testID="history-bar" style={styles.bar}>
		<Text testID="history-bar-count" role="status" style={[styles.value, { flex: 1 }]}>{ticked(count)}</Text>
		<CardButton testID="history-clear" label="Clear" onPress={controller.clear} />
		<CardButton testID="history-preview" label="Preview undo" primary onPress={controller.openPreview} />
	</View>;
}

function VersionPanel({ state, controller, words }: { state: HistoryState; controller: HistoryController; words: HistoryWords }) {
	const styles = useStyles();
	const v = state.version!;
	const kind = state.target?.kind ?? 'task';
	const lines = v.value ? versionLines(v.value.snapshot, kind, state.names, { ...words, names: controller.loadedNames() }) : [];
	return <View testID="history-version" style={styles.list}>
		<Text role="heading" aria-level={2} style={styles.versionTitle}>{v.value ? `As it was ${setTime(v.value.createdAt, words).replace(/^Today/, 'today')}` : 'As it was then'}</Text>
		{v.phase === 'loading' ? <Text style={styles.muted}>{historyCopy.versionLoading}</Text> : null}
		{v.phase === 'failed' ? <Note tone="warn" testID="history-version-failed">{historyCopy.versionFailed}</Note> : null}
		{v.value ? <View style={styles.set}>{lines.map((l, i) => <View key={l.label} style={[styles.chg, i === lines.length - 1 && styles.chgLast]}>
			<Text style={[styles.muted, { width: 92 }]}>{l.label}</Text><Text style={[styles.chgWords, { flex: 1 }]}>{l.value}</Text></View>)}</View> : null}
		{v.value?.removed ? <Text style={styles.muted}>This was the record just before it was removed.</Text> : null}
		<Text style={styles.muted}>Read only. Nothing here changes the record.</Text>
		<CardButton testID="history-version-back" label={historyCopy.versionBack} onPress={controller.closeVersion} />
	</View>;
}

const useStyles = themedStyles((colors) => ({
	sub: { fontSize: type.small, color: colors.muted, marginTop: 2, marginBottom: 10, paddingHorizontal: 4 },
	list: { gap: 10, width: '100%', maxWidth: space.maxContentWidth, alignSelf: 'center' },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
	muted: { fontSize: 13, lineHeight: 18, color: colors.muted },
	strong: { fontWeight: '700', color: colors.heading },
	value: { fontWeight: '600', color: colors.heading },
	link: { color: colors.action, fontWeight: '600', textDecorationLine: 'underline' },
	startRow: { paddingHorizontal: 4, paddingTop: 2 },
	linkBox: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignSelf: 'flex-start' },
	note: { flexDirection: 'row', gap: 8, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'flex-start' },
	noteOk: { backgroundColor: colors.needsYou, borderColor: colors.needsYouLine },
	noteText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.body },
	tick: { fontSize: 14, lineHeight: 18, color: colors.body, fontWeight: '700' },
	recovered: { gap: 8 },
	set: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14, overflow: 'hidden' },
	setFocused: { borderColor: colors.action },
	setHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderColor: colors.rowLine },
	setWho: { flex: 1, minWidth: 0, fontSize: 13, color: colors.muted },
	avatar: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.sage },
	initials: { fontSize: 10, fontWeight: '700', color: colors.sageText },
	chg: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 12, paddingVertical: 11, borderBottomWidth: 1, borderColor: colors.rowLine, minHeight: 44 },
	chgWeb: { paddingHorizontal: 0, paddingVertical: 0 },
	chgLast: { borderBottomWidth: 0 },
	picked: { backgroundColor: colors.needsYou },
	chgText: { flex: 1, minWidth: 0 },
	chgWords: { fontSize: type.body, lineHeight: type.bodyLine, color: colors.heading },
	chgNote: { fontSize: 12, lineHeight: 17, color: colors.muted, marginTop: 3 },
	glyph: { width: 20, alignItems: 'center', paddingTop: 1 },
	badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 9, overflow: 'hidden', marginTop: 1 },
	badgeWarn: { backgroundColor: colors.warning, color: colors.warningText },
	badgeOff: { backgroundColor: colors.neutral, color: colors.neutralText },
	badgeDone: { backgroundColor: colors.sage, color: colors.sageText },
	box: { width: 20, height: 20, borderRadius: 4, borderWidth: 1.5, borderColor: colors.muted, alignItems: 'center', justifyContent: 'center' },
	boxOn: { backgroundColor: colors.action, borderColor: colors.action },
	boxTick: { fontSize: 13, lineHeight: 15, color: colors.actionText, fontWeight: '700' },
	bar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 14, borderTopWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
	versionTitle: { fontSize: 18, fontWeight: '600', color: colors.heading }
}));
