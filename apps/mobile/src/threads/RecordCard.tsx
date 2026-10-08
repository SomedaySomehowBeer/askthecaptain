/** The small card on top of a thread (D27) and its fold-out. For a task, a booking or a stock item the fold-out is the
 *  record's editor (R3 V-D; design boards 1 and 2); for a topic or private thread it is read-only, as in R2. Tags stay
 *  on every card: their chips, and the existing revision-checked controls. */
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
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
import { MakeTask } from './cards/MakeTask.tsx';
import { MakeBooking } from './cards/MakeBooking.tsx';
import { cardCopy } from './cards/copy.ts';
import type { RecordState } from './cards/store.ts';
import type { CardHooks } from './cards/useSaver.ts';
import { themedStyles, useTheme } from '../theme/theme.ts';
import { faces, type } from '../theme/tokens.ts';
import { ChevronDown } from '../components/Icons.tsx';

const statusWords: Record<string, string> = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled', suggested: 'Suggested', confirmed: 'Confirmed',
	maintenance: 'Maintenance', not_counted: 'Not counted', counted: 'Counted', below_reorder: 'Below reorder point', archived: 'Archived' };

export function RecordCard({ detail, calls, scope, now, fold, setFold, disabled, locked, record, hooks, confirmed, onTag, onMembers = () => {} }: {
	detail: Detail; calls: ThreadCalls; scope: ReadScope; now: () => number; fold: boolean; setFold: (v: boolean) => void; disabled: boolean; locked: boolean;
	record: RecordState; hooks: CardHooks; confirmed: readonly string[]; onTag: (tagId: string, attached: boolean) => void; onMembers?: () => void;
}) {
	const styles = useStyles();
	const { colors } = useTheme();
	const kind = detail.card.record?.kind;
	const year = new Date().getFullYear(); // wall clock: `now` is monotonic
	const status = detail.card.status ? statusWords[detail.card.status] ?? detail.card.status : null;
	const editorProps = { calls, scope, detail, record, hooks, locked, confirmed };
	// The tag chips are the card's (design boards 1 and 2); the controls that change them open on request.
	const [tagging, setTagging] = useState(false);
	const [making, setMaking] = useState<'task' | 'booking'>('task');
	const [bookingOpened, setBookingOpened] = useState(false);
	return <View testID="thread-card" style={styles.card}>
		<Pressable testID="thread-card-fold" role="button" aria-expanded={fold} aria-label={fold ? 'Hide details' : 'Show details'} hitSlop={6} onPress={() => setFold(!fold)} style={styles.head}>
			<Text role="heading" numberOfLines={fold ? 3 : 2} style={styles.title}>{detail.card.title}</Text>
			{status ? <Text style={styles.status}>{status}</Text> : null}
			<View style={styles.chevron}><ChevronDown color={colors.heading} up={fold} size={8} /></View>
		</Pressable>
		{!fold || !kind ? <View style={styles.facts}>{detail.card.facts.map((fact, i) => <View key={i} testID={`thread-fact-${i}`} style={styles.fact}>
			<Text style={styles.label}>{factLabels(kind)[i]}</Text><Text style={styles.factText} numberOfLines={1}>{factWords(fact, year, record.zone ?? undefined)}</Text></View>)}</View> : null}
		{/* The unfolded card grows to its content and scrolls with the thread (R3 boards 1 to 3): nothing in it is below
		    a fold of its own. */}
		{fold ? <View style={styles.fold} testID="thread-details">
			{kind === 'task' ? <TaskEditor {...editorProps} />
				: kind === 'booking' ? <BookingEditor {...editorProps} year={year} />
					: kind === 'stock' ? <StockEditor {...editorProps} year={year} />
						: detail.thread.kind === 'topic' && !cardDetails(detail.card).length ? null : <Text style={styles.body}>{cardDetails(detail.card).join('\n') || 'No further details.'}</Text>}
			<View style={styles.chips} testID="thread-tag-chips">{detail.tags.length ? detail.tags.map((t) => <Text key={t.id} style={styles.chip}>{t.name}</Text>) : <Text style={styles.label}>No tags</Text>}
				<View style={{ flex: 1 }} /><CardButton testID="thread-tags-toggle" label={tagging ? 'Close tags' : 'Change tags'} quiet onPress={() => setTagging(!tagging)} />
				<View style={{ marginLeft: 10 }}><CardButton testID="thread-history-link" label="History" quiet link onPress={() => router.push(`/threads/${detail.thread.id}/history` as never)} /></View></View>
			{tagging ? <TagControls calls={calls} scope={scope} detail={detail} now={now} disabled={disabled} change={onTag} /> : null}
			{/* A topic becomes a task (board 3) or a booking (bookings contract §3): one form shown at a time, the task's first.
			    Both stay mounted once opened, so an uncertain write in either keeps its id and body until retried or discarded. */}
			{!kind && detail.thread.kind === 'topic' ? <>
				<View style={[styles.making, making === 'task' ? null : styles.hidden]}>
					<MakeTask calls={calls} scope={scope} detail={detail} record={record} hooks={hooks} locked={locked} confirmed={confirmed}
						onMembers={onMembers} onCancel={() => setFold(false)} />
					<CardButton testID="make-booking-open" label={cardCopy.makeBookingOpen} quiet disabled={locked} onPress={() => { setMaking('booking'); setBookingOpened(true); }} />
				</View>
				{bookingOpened ? <View style={[styles.making, making === 'booking' ? null : styles.hidden]}>
					<MakeBooking calls={calls} scope={scope} detail={detail} hooks={hooks} locked={locked} confirmed={confirmed} onCancel={() => setMaking('task')} />
				</View> : null}
			</> : null}
			{recordRoute(detail) ? <Button label="Open the record" onPress={() => router.push(recordRoute(detail)!)} /> : null}
			{detail.thread.kind === 'private' ? <Text style={styles.body}>{copy.privacy}</Text> : null}
		</View> : null}
	</View>;
}

/** A fact that is a calendar date or an instant, as people say it ("Thu 8 Oct", "Thu 8 Oct, 8:00 am"); text as it is. */
function factWords(fact: string, year: number, zone?: string): string {
	if (/^\d{4}-\d{2}-\d{2}$/.test(fact)) return wordDate(fact, year);
	if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(fact)) { const at = wordInstant(fact, zone, year); return at ? `${at.day}, ${at.time}` : fact; }
	return fact;
}

/** R3 captain.css `.card`, `.card-head`, `.card-title`, `.chip`, `.facts`, `.label`, `.value`. */
const useStyles = themedStyles((colors) => ({
	card: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, gap: 8 },
	head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, marginVertical: -4 },
	title: { flex: 1, minWidth: 0, fontFamily: faces.display, fontSize: type.cardTitle, lineHeight: type.cardTitleLine, color: colors.heading },
	status: { fontSize: type.chip, lineHeight: 16, fontWeight: '600', color: colors.sageText, backgroundColor: colors.sage, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, maxWidth: 140, overflow: 'hidden' },
	chevron: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
	facts: { flexDirection: 'row', gap: 12 },
	fact: { flex: 1, minWidth: 0 },
	factText: { fontSize: type.body, lineHeight: type.bodyLine, fontWeight: '600', color: colors.heading },
	label: { fontSize: 11, lineHeight: 15, color: colors.muted },
	body: { fontSize: type.body, lineHeight: type.bodyLine, color: colors.body },
	fold: { gap: 10, paddingTop: 2 },
	making: { gap: 10 },
	hidden: { display: 'none' },
	chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
	chip: { fontSize: type.chip, lineHeight: 16, fontWeight: '600', paddingHorizontal: 9, paddingVertical: 3, borderRadius: 10, backgroundColor: colors.page, borderWidth: 1, borderColor: colors.line, color: colors.body, overflow: 'hidden' }
}));
