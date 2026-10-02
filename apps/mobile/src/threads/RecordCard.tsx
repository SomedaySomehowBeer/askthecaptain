/** The small card on top of a thread (D27) and its fold-out. For a task, a booking or a stock item the fold-out is the
 *  record's editor (R3 V-D; design boards 1 and 2); for a topic or private thread it is read-only, as in R2. Tags stay
 *  on every card: their chips, and the existing revision-checked controls. */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { ReadScope } from '../account/contracts.ts';
import { Button } from '../components/AccountPage.tsx';
import type { ThreadCalls } from './api.ts';
import type { Detail } from './contracts.ts';
import { copy } from './copy.ts';
import { cardDetails, recordRoute } from './derive.ts';
import { factLabels } from './Presentation.tsx';
import { wordDate, wordInstant } from './wording.ts';
import { TagControls } from './TagControls.tsx';
import { BookingEditor } from './cards/BookingEditor.tsx';
import { StockEditor } from './cards/StockEditor.tsx';
import { TaskEditor } from './cards/TaskEditor.tsx';
import { CardButton } from './cards/Fields.tsx';
import type { RecordState } from './cards/store.ts';
import type { CardHooks } from './cards/useSaver.ts';
import { themedStyles, useTheme } from '../theme/theme.ts';

const statusWords: Record<string, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled', suggested: 'Suggested', confirmed: 'Confirmed',
	maintenance: 'Maintenance', not_counted: 'Not counted', counted: 'Counted', below_reorder: 'Below reorder point', archived: 'Archived' };

export function RecordCard({ detail, calls, scope, now, fold, setFold, disabled, locked, record, hooks, confirmed, onTag }: {
	detail: Detail; calls: ThreadCalls; scope: ReadScope; now: () => number; fold: boolean; setFold: (v: boolean) => void; disabled: boolean; locked: boolean;
	record: RecordState; hooks: CardHooks; confirmed: readonly string[]; onTag: (tagId: string, attached: boolean) => void;
}) {
	const styles = useStyles();
	const { colors } = useTheme();
	const { height } = useWindowDimensions();
	const kind = detail.card.record?.kind;
	const year = new Date().getFullYear(); // wall clock: `now` is monotonic
	const status = detail.card.status ? statusWords[detail.card.status] ?? detail.card.status : null;
	const editorProps = { calls, scope, detail, record, hooks, locked, confirmed };
	// The tag chips are the card's (design boards 1 and 2); the controls that change them open on request.
	const [tagging, setTagging] = useState(false);
	return <View testID="thread-card" style={styles.card}>
		<Pressable testID="thread-card-fold" role="button" aria-expanded={fold} aria-label={fold ? 'Hide details' : 'Show details'} hitSlop={6} onPress={() => setFold(!fold)} style={styles.head}>
			<Text role="heading" numberOfLines={fold ? 2 : 1} style={styles.title}>{detail.card.title}</Text>
			{status ? <Text style={styles.status}>{status}</Text> : null}
			<Text aria-hidden style={[styles.chevron, { color: colors.plain }]}>{fold ? '⌃' : '⌄'}</Text>
		</Pressable>
		{!fold || !kind ? <View style={styles.facts}>{detail.card.facts.map((fact, i) => <View key={i} testID={`thread-fact-${i}`} style={styles.fact}>
			<Text style={styles.small}>{factLabels(kind)[i]}</Text><Text style={styles.factText} numberOfLines={1}>{factWords(fact, year, record.zone ?? undefined)}</Text></View>)}</View> : null}
		{fold ? <ScrollView style={{ maxHeight: Math.max(240, Math.round(height * 0.58)) }} contentContainerStyle={styles.fold} testID="thread-details">
			{kind === 'task' ? <TaskEditor {...editorProps} />
				: kind === 'booking' ? <BookingEditor {...editorProps} year={year} />
					: kind === 'stock' ? <StockEditor calls={calls} scope={scope} detail={detail} hooks={hooks} locked={locked} confirmed={confirmed} year={year} />
						: <Text style={styles.body}>{cardDetails(detail.card).join('\n') || 'No further details.'}</Text>}
			<View style={styles.chips} testID="thread-tag-chips">{detail.tags.length ? detail.tags.map((t) => <Text key={t.id} style={styles.chip}>{t.name}</Text>) : <Text style={styles.small}>No tags</Text>}
				<View style={{ flex: 1 }} /><CardButton testID="thread-tags-toggle" label={tagging ? 'Close tags' : 'Change tags'} quiet onPress={() => setTagging(!tagging)} /></View>
			{tagging ? <TagControls calls={calls} scope={scope} detail={detail} now={now} disabled={disabled} change={onTag} /> : null}
			{recordRoute(detail) ? <Button label="Open the record" onPress={() => router.push(recordRoute(detail)!)} /> : null}
			{detail.thread.kind === 'private' ? <Text style={styles.body}>{copy.privacy}</Text> : null}
		</ScrollView> : null}
	</View>;
}

/** A fact that is a calendar date or an instant, as people say it ("Thu 8 Oct", "Thu 8 Oct, 8:00 am"); text as it is. */
function factWords(fact: string, year: number, zone?: string): string {
	if (/^\d{4}-\d{2}-\d{2}$/.test(fact)) return wordDate(fact, year);
	if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(fact)) { const at = wordInstant(fact, zone, year); return at ? `${at.day}, ${at.time}` : fact; }
	return fact;
}

const useStyles = themedStyles((colors) => ({
	card: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, gap: 6 },
	head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
	title: { flex: 1, minWidth: 0, fontSize: 17, fontWeight: '600', color: colors.heading },
	status: { fontSize: 12, fontWeight: '600', color: colors.sageText, backgroundColor: colors.sage, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, maxWidth: 140, overflow: 'hidden' },
	chevron: { width: 24, textAlign: 'center', fontSize: 16 },
	facts: { flexDirection: 'row', gap: 12 },
	fact: { flex: 1, minWidth: 0 },
	factText: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.heading },
	small: { fontSize: 11, color: colors.muted },
	body: { fontSize: 14, lineHeight: 20, color: colors.body },
	fold: { gap: 10, paddingTop: 4, paddingBottom: 4 },
	chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
	chip: { fontSize: 12, fontWeight: '600', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, backgroundColor: colors.page, borderWidth: 1, borderColor: colors.line, color: colors.body, overflow: 'hidden' }
}));
