/** The preview sheet over History (design boards 7–10): for each ticked change its name, now and after; what stays
 *  untouched and that nothing is erased; with a conflict, the explanation and the person's two choices (Captain never
 *  chooses); a coupled group's missing members; a blocked change's reason (a booking slot names what holds it); a stale
 *  apply's fresh preview with what still applies. A labelled modal dialog: on the web it traps focus and Escape closes
 *  it (react-native-web's Modal). */
import { Modal, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { themedStyles } from '../../theme/theme.ts';
import { faces, space, type } from '../../theme/tokens.ts';
import { CardButton } from '../cards/Fields.tsx';
import type { Entry, PreviewEntry } from './contracts.ts';
import type { HistoryController, HistoryState } from './controller.ts';
import { entryIndex } from './controller.ts';
import { historyCopy, undoLabel } from './copy.ts';
import {
	actorName, blockedReason, conflictWords, entryName, fieldNoun, irreversibleReason, onDay, remainingLabel, staleAlert, staleConflict, together, untouched, valueWords, type HistoryWords
} from './words.ts';
import { firstNameOf } from '../wording.ts';

const titleId = 'undo-sheet-title';

export function PreviewSheet({ state, controller, words, onSchedule, onSetYourself, waiting = false }: {
	state: HistoryState; controller: HistoryController; words: HistoryWords; onSchedule: () => void; onSetYourself: () => void;
	/** A 429 (or an uncertain answer's Retry-After) asked to wait: the sheet stays, its actions wait. */
	waiting?: boolean;
}) {
	const styles = useStyles();
	const { height } = useWindowDimensions();
	const sheet = state.sheet;
	if (!sheet) return null;
	const preview = sheet.preview;
	const n = preview?.changes.length ?? new Set(sheet.selection.map((id) => entryIndex(state.sets).get(id)?.entry.id ?? id)).size;
	const index = entryIndex(state.sets);
	const names = { ...state.names, people: { ...state.names.people, ...preview?.names.people }, tags: { ...state.names.tags, ...preview?.names.tags } };
	const w: HistoryWords = { ...words, names: { ...controller.loadedNames(), ...words.names } };
	const stale = sheet.stale !== null && preview !== null;
	const remaining = preview?.changes.filter((c) => c.state === 'reversible') ?? [];
	const busy = sheet.phase === 'applying' || sheet.phase === 'loading';
	// What stays untouched: the newest entry in effect on this record that is not part of this undo.
	const selected = new Set(preview?.changes.flatMap((c) => c.changeIds) ?? sheet.selection);
	const others = state.sets.flatMap((set) => set.changes.filter((e) => !e.changeIds.some((id) => selected.has(id)) && e.state !== 'reversed' && !(e.operation === 'create' && !e.itemKind))
		.map((entry) => ({ entry, set })));
	const primaryLabel = stale ? remainingLabel(remaining, preview!.changes.length, names, w) : undoLabel(n);
	const canApply = !waiting && sheet.phase === 'ready' && preview !== null && (stale ? remaining.length > 0 : preview.applicable);

	return <Modal transparent animationType="none" visible onRequestClose={controller.closeSheet} {...({ 'aria-labelledby': titleId } as object)}>
		<View style={styles.scrim} testID="undo-scrim" aria-hidden />
		<View testID="undo-sheet" style={[styles.sheet, { maxHeight: Math.round(height * 0.88) }]}>
			<Text nativeID={titleId} role="heading" aria-level={2} style={styles.title}>{undoLabel(n)}</Text>
			<ScrollView contentContainerStyle={styles.body} style={{ flexGrow: 0 }}>
				{stale ? <View testID="undo-stale" role="alert" style={[styles.note, styles.noteWarn]}><Text aria-hidden style={styles.warnGlyph}>⚠</Text>
					<Text style={styles.noteWarnText}><Text style={styles.strongWarn}>Nothing was undone.</Text> {staleAlert(preview!.changes, names, w)}</Text></View> : null}
				{sheet.phase === 'loading' ? <Text testID="undo-loading" style={styles.muted}>{historyCopy.previewing}</Text> : null}
				{preview?.changes.map((entry) => <PreviewRow key={entry.id} entry={entry} stale={stale} controller={controller} words={w} names={names}
					origin={index.get(entry.id)} onSchedule={onSchedule} onSetYourself={onSetYourself} disabled={busy || sheet.phase === 'uncertain'} />)}
				{preview?.applicable && !stale ? <>
					<View testID="undo-untouched" style={[styles.note, styles.noteOk]}><Text aria-hidden style={styles.okGlyph}>✓</Text><Text style={styles.noteText}>{untouched(others, w)}</Text></View>
					<Text style={[styles.muted, styles.pad]}>{historyCopy.untouchedTail}</Text>
				</> : null}
				{sheet.message && sheet.phase !== 'loading' ? <Text testID="undo-status" role="status" style={sheet.phase === 'applying' ? styles.muted : styles.warnText}>{sheet.message}</Text> : null}
			</ScrollView>
			<View style={styles.row}>
				{sheet.phase === 'uncertain' ? <>
					<CardButton testID="undo-check" label="Check History for this undo" display="Check History" onPress={controller.check} />
					<CardButton testID="undo-retry" label="Undo again with the same change ID" display="Undo again" primary grow disabled={waiting} onPress={controller.retry} />
				</> : sheet.phase === 'failed' ? <>
					<CardButton testID="undo-cancel" label="Cancel" onPress={controller.closeSheet} />
					<CardButton testID="undo-try-again" label="Try the preview again" display="Try again" primary grow disabled={waiting} onPress={controller.retryPreview} />
				</> : <>
					<CardButton testID="undo-cancel" label="Cancel" disabled={sheet.phase === 'applying'} onPress={controller.closeSheet} />
					<CardButton testID="undo-apply" label={primaryLabel} primary grow offNeutral disabled={!canApply} onPress={controller.apply} />
				</>}
			</View>
		</View>
	</Modal>;
}

function PreviewRow({ entry, stale, controller, words, names, origin, onSchedule, onSetYourself, disabled }: {
	entry: PreviewEntry; stale: boolean; controller: HistoryController; words: HistoryWords; names: HistoryState['names'];
	origin: { entry: Entry; set: { actor: { kind: 'person' | 'workflow' | 'system'; id: string | null; name: string | null }; createdAt: string } } | undefined;
	onSchedule: () => void; onSetYourself: () => void; disabled: boolean;
}) {
	const styles = useStyles();
	const name = entryName(entry, names, words);
	const both = <View style={styles.vals}>
		<Text style={styles.dt}>Now</Text><Text testID={`undo-now-${entry.id}`} style={styles.dd}>{valueWords(entry, 'now', names, words)}</Text>
		<Text style={styles.dt}>After</Text><Text testID={`undo-after-${entry.id}`} style={[styles.dd, entry.state === 'reversible' && styles.ddStrong]}>{valueWords(entry, 'proposed', names, words)}</Text>
	</View>;
	const group = together(entry);
	const who = origin ? `${firstNameOf(origin.set.actor.name) ?? actorName(origin.set.actor)} changed it` : null;
	const fromTo = origin && !entry.itemKind && entry.field && entry.operation === 'update' && !['time', 'count', 'status'].includes(entry.field)
		? ` from ${valueWords({ ...entry, now: entry.before } as PreviewEntry, 'now', names, words)} to ${valueWords({ ...entry, now: entry.after } as PreviewEntry, 'now', names, words)}` : '';
	const card = <View testID={`undo-entry-${entry.id}`} style={styles.pv}>
		<View style={styles.pvHead}><Text style={[styles.pvWhat, { flex: 1 }]}>{name}</Text>
			{stale && entry.state === 'conflict' ? <Text testID={`undo-badge-${entry.id}`} style={[styles.badge, styles.badgeWarn]}>Changed since</Text> : null}</View>
		{entry.state === 'conflict' && !stale && who && origin ? <Text style={styles.muted}>{who}{fromTo} {onDay(origin.set.createdAt, words)}.</Text> : null}
		{both}
		{group ? <Text style={styles.muted}>{group}</Text> : null}
		{entry.state === 'conflict' && stale ? <Text testID={`undo-stale-note-${entry.id}`} style={styles.muted}>{staleConflict(entry, names, words)}</Text> : null}
		{entry.state === 'irreversible' ? <Text testID={`undo-reason-${entry.id}`} style={styles.warnText}>{irreversibleReason(entry.reason, entry)}</Text> : null}
		{entry.state === 'reversed' ? <Text testID={`undo-reason-${entry.id}`} style={styles.warnText}>{`Already undone by ${actorName(entry.reversedBy.actor)} ${onDay(entry.reversedBy.at, words)}. Untick it, or undo that undo instead.`}</Text> : null}
	</View>;
	// What needs the person's choice sits under the change, as boards 8 and 9 draw it.
	if (entry.state === 'conflict' && !stale) {
		const c = conflictWords(entry, names, words);
		const later = entry.later.map((l) => l.id);
		return <>{card}
			<View testID={`undo-conflict-${entry.id}`} role="alert" style={[styles.note, styles.noteWarn]}><Text aria-hidden style={styles.warnGlyph}>⚠</Text><Text style={styles.noteWarnText}>{c.note}</Text></View>
			<CardButton testID={`undo-also-${entry.id}`} label={c.also} start disabled={disabled} onPress={() => controller.add(later)} />
			<CardButton testID={`undo-yourself-${entry.id}`} label={historyCopy.setYourself(entry.itemKind ? (entry.itemKind === 'tag' ? 'tags' : `${entry.itemKind}s`) : fieldNoun(entry.field))} start disabled={disabled} onPress={onSetYourself} />
		</>;
	}
	if (entry.state === 'needs') return <>{card}
		<View testID={`undo-needs-${entry.id}`} role="alert" style={[styles.note, styles.noteWarn]}><Text aria-hidden style={styles.warnGlyph}>⚠</Text><Text style={styles.noteWarnText}>{historyCopy.needs}</Text></View>
		<CardButton testID={`undo-add-${entry.id}`} label={historyCopy.addCompanions} start disabled={disabled} onPress={() => controller.add(entry.needs)} />
	</>;
	if (entry.state === 'blocked') return <>{card}
		<View testID={`undo-blocked-${entry.id}`} role="alert" style={[styles.note, entry.reason === 'already_current' ? styles.noteNeutral : styles.noteWarn]}>
			<Text aria-hidden style={entry.reason === 'already_current' ? styles.neutralGlyph : styles.warnGlyph}>{entry.reason === 'already_current' ? 'i' : '⚠'}</Text>
			<Text style={entry.reason === 'already_current' ? styles.noteNeutralText : styles.noteWarnText}>{blockedReason(entry, names, words)}</Text></View>
		{entry.reason === 'slot_taken' ? <CardButton testID={`undo-schedule-${entry.id}`} label={historyCopy.schedule} start disabled={disabled} onPress={onSchedule} /> : null}
	</>;
	return card;
}

const useStyles = themedStyles((colors) => ({
	scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.shadow, opacity: 0.5 },
	sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.page, borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 12, paddingTop: 16, paddingBottom: 16, gap: 10,
		width: '100%', maxWidth: space.maxContentWidth, alignSelf: 'center', marginHorizontal: 'auto' },
	title: { fontFamily: faces.display, fontSize: type.sheetTitle, lineHeight: type.sheetTitleLine, color: colors.heading, paddingHorizontal: 4 },
	body: { gap: 10 },
	pv: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, gap: 6 },
	pvHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	pvWhat: { fontWeight: '600', fontSize: 15, color: colors.heading },
	vals: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 3 },
	dt: { width: 52, fontSize: 14, lineHeight: 19, color: colors.muted },
	dd: { width: '75%', flexGrow: 1, fontSize: 14, lineHeight: 19, color: colors.heading },
	ddStrong: { fontWeight: '700' },
	muted: { fontSize: 13, lineHeight: 18, color: colors.muted },
	pad: { paddingHorizontal: 4 },
	warnText: { fontSize: 13, lineHeight: 18, color: colors.warningText },
	note: { flexDirection: 'row', gap: 8, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'flex-start' },
	noteOk: { backgroundColor: colors.needsYou, borderColor: colors.needsYouLine },
	noteWarn: { backgroundColor: colors.warning, borderColor: colors.warningLine },
	noteNeutral: { backgroundColor: colors.neutral, borderColor: colors.neutral },
	noteText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.body },
	noteWarnText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.warningText },
	noteNeutralText: { flex: 1, fontSize: 13, lineHeight: 18, color: colors.neutralText },
	strongWarn: { fontWeight: '700', color: colors.warningText },
	warnGlyph: { fontSize: 13, lineHeight: 18, color: colors.warningText },
	neutralGlyph: { fontSize: 13, lineHeight: 18, color: colors.neutralText, fontWeight: '700' },
	okGlyph: { fontSize: 13, lineHeight: 18, color: colors.body, fontWeight: '700' },
	badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 9, overflow: 'hidden' },
	badgeWarn: { backgroundColor: colors.warning, color: colors.warningText },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 }
}));
