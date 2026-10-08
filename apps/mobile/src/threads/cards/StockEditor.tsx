/** A stock item's unfolded card (stock contract §3; design board 1's pattern, which the R3 README names for the stock
 *  card: "the task card's pattern with a count and a note"): its details saved together as one revision-checked change,
 *  a count from the card as before (an observation, not a revision-checked edit: the API records who and when), the
 *  last three counts, a link to Stocktake, and "Archive this item" after a confirm step (an archived item offers
 *  "Restore this item"). */
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReadScope } from '../../account/contracts.ts';
import type { ThreadCalls } from '../api.ts';
import type { Detail } from '../contracts.ts';
import { themedStyles } from '../../theme/theme.ts';
import { wordInstant } from '../wording.ts';
import { firstName } from '../derive.ts';
import { CardButton, Muted, Note, TextField } from './Fields.tsx';
import { refusedForGood, validCount } from './forms.ts';
import { useDeadline } from '../use-poll.ts';
import { send, writes, type Count } from './records.ts';
import type { RecordState } from './store.ts';
import { useSaver, type CardHooks } from './useSaver.ts';
import { cardCopy } from './copy.ts';
import { ItemFields } from '../../resources/stock/ItemFields.tsx';
import { countWords, detailChanges, detailsForm, itemProblem, stockRefusals, stockWrites, type ItemDetails, type StockItem } from '../../resources/stock/stock.ts';

const detailsCopy = { ...cardCopy.task, refusals: stockRefusals };
const archiveCopy = { saving: 'Saving…', saved: 'Saved. The change is in the thread.', confirmed: 'Change confirmed. It is in the thread.', refusals: stockRefusals };

export function StockEditor({ calls, scope, detail, record, hooks, locked, confirmed, year }: {
	calls: ThreadCalls; scope: ReadScope; detail: Detail; record: RecordState; hooks: CardHooks; locked: boolean; confirmed: readonly string[]; year: number;
}) {
	const styles = useStyles();
	const f = detail.card.fold, itemId = detail.card.record!.id;
	const item: StockItem | null = record.stock?.item.id === itemId ? record.stock.item : null;
	const unit = item?.unitLabel ?? (typeof f.unitLabel === 'string' ? f.unitLabel : '');
	const [count, setCount] = useState(''), [note, setNote] = useState('');
	const [saver, state] = useSaver<Count>(hooks, cardCopy.count, () => { setCount(''); setNote(''); });
	// Details: the task card's form rules (TaskEditor): a newer item replaces an untouched form; an edited one is kept.
	const [form, setForm] = useState<ItemDetails | null>(item ? detailsForm(item) : null);
	const [base, setBase] = useState<StockItem | null>(item);
	const resync = useRef(false);
	const [own] = useState<CardHooks>(() => ({ ...hooks, reload: () => { resync.current = true; hooks.reload(); } }));
	const [details, detailState] = useSaver<StockItem & { changeSetId: string }>(own, detailsCopy, () => { resync.current = true; });
	const [asking, setAsking] = useState(false);
	const [archiving, archiveState] = useSaver<StockItem & { changeSetId: string }>(own, archiveCopy, () => { setAsking(false); });
	useEffect(() => {
		if (!item) return;
		if (resync.current || !form || !base || base.revision !== item.revision || base.id !== item.id) {
			if (!form || !base || !detailChanges(base, form) || resync.current) setForm(detailsForm(item));
			resync.current = false; setBase(item);
		}
	}, [item]);
	useEffect(() => { saver.confirm(confirmed); details.confirm(confirmed); archiving.confirm(confirmed); }, [confirmed]);
	const archived = item ? item.archivedAt !== null : f.archivedAt !== null && f.archivedAt !== undefined;
	const counted = typeof f.currentCount === 'string' ? `${f.currentCount}${unit ? ` ${unit}` : ''}` : null;
	const when = typeof f.countedAt === 'string' ? wordInstant(f.countedAt, record.zone ?? undefined, year) : null;
	const invalid = count ? validCount(count) : null;
	const waiting = useDeadline(state.waitUntil, hooks.now), detailWaiting = useDeadline(detailState.waitUntil, hooks.now), archiveWaiting = useDeadline(archiveState.waitUntil, hooks.now);
	const editable = !locked && !archived && !state.busy && !state.uncertain;
	const save = () => {
		if (validCount(count)) return;
		const value = count.trim(), words = note;
		void saver.save((id) => { const w = writes.count(scope, itemId, id, value, words); return { body: w.body, send: () => send(calls, scope, w) }; });
	};
	const detailBusy = detailState.busy || detailState.uncertain;
	const detailEditable = Boolean(item && form) && !locked && !archived && !detailBusy;
	const changes = item && form && base ? detailChanges(base, form) : null;
	const problem = form ? itemProblem(form) : null;
	const archiveBusy = archiveState.busy || archiveState.uncertain || archiveWaiting;
	const archive = (to: boolean) => { if (!base) return; void archiving.save((id) => { const w = stockWrites.archive(scope, base, id, to); return { body: w.body, send: () => send(calls, scope, w) }; }); };
	return <View style={styles.box} testID="stock-editor">
		{archived ? <Note tone="neutral" testID="stock-archived">{cardCopy.archivedStock}</Note> : null}
		{!item ? (record.message ? <Note tone="warn" testID="card-record-status">{record.message}</Note> : <Muted testID="card-record-loading">{cardCopy.loading}</Muted>) : null}
		{item && form && !archived ? <View style={styles.box} testID="stock-details">
			<ItemFields prefix="stock" form={form} set={(next) => { setForm({ ...form, ...next }); if (!detailBusy) details.clear(); }} disabled={!detailEditable}
				locations={record.stock?.locations ?? []} unitLocked={item.currentCount !== null} />
			{problem ? <Muted testID="stock-details-invalid">{problem}</Muted> : null}
			<View style={styles.row}>
				{detailState.uncertain
					? <><CardButton testID="stock-details-retry" label="Save again with the same change ID" display="Save again" primary grow disabled={detailState.busy || detailWaiting} onPress={() => { void details.retry(); }} />
						<CardButton testID="stock-details-discard" label="Discard these changes" display="Discard" disabled={detailState.busy} onPress={() => { details.discard(); setForm(detailsForm(item)); setBase(item); }} /></>
					: <><CardButton testID="stock-details-save" label="Save changes" primary grow disabled={!detailEditable || detailWaiting || !changes || Boolean(problem) || refusedForGood(detailState.refusal)}
						onPress={() => { if (!changes || !base) return; const c = changes, b = base; void details.save((id) => { const w = stockWrites.edit(scope, b, id, c); return { body: w.body, send: () => send(calls, scope, w) }; }); }} />
						<CardButton testID="stock-details-cancel" label="Discard your edits" display="Discard edits" disabled={detailState.busy || !changes} onPress={() => { setForm(detailsForm(base ?? item)); details.clear(); }} /></>}
			</View>
			{detailState.message ? <Text testID="stock-details-status" role="status" style={detailState.tone === 'warn' ? styles.warn : styles.ok}>{detailState.message}</Text> : <Muted testID="stock-details-help">{cardCopy.saveTogether}</Muted>}
		</View> : null}
		<View style={styles.section}>
			<Text style={styles.legend}>Count</Text>
			<Muted testID="stock-last">{counted ? `Last count: ${counted}${when ? `, ${when.day} at ${when.time}` : ''}.` : cardCopy.notCounted}</Muted>
		</View>
		{archived ? null : <>
			<View style={styles.facts}>
				<TextField label={unit ? `Count (${unit})` : 'Count'} testID="stock-count" value={count} onChange={(v) => { setCount(v); if (!state.uncertain) saver.clear(); }} disabled={!editable} keyboard="decimal-pad" maxLength={80} wide={false} />
				<TextField label="Note (optional)" testID="stock-note" value={note} onChange={setNote} disabled={!editable} maxLength={1000} wide={false} />
			</View>
			{invalid ? <Muted testID="stock-invalid">{invalid}</Muted> : null}
			<View style={styles.row}>
				{state.uncertain
					? <><CardButton testID="stock-retry" label="Save the count again with the same change ID" display="Save again" primary grow disabled={state.busy || waiting} onPress={() => { void saver.retry(); }} />
						<CardButton testID="stock-discard" label="Discard this count" display="Discard" disabled={state.busy} onPress={() => { saver.discard(); setCount(''); setNote(''); }} /></>
					: <><CardButton testID="stock-save" label="Save count" primary grow disabled={!editable || waiting || !count.trim() || Boolean(invalid) || refusedForGood(state.refusal)} onPress={save} />
						<CardButton testID="stock-cancel" label="Clear the count and note" display="Clear" disabled={state.busy || (!count && !note)} onPress={() => { setCount(''); setNote(''); saver.clear(); }} /></>}
			</View>
			{state.message ? <Text testID="stock-save-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : <Muted testID="stock-help">{cardCopy.countHelp}</Muted>}
		</>}
		{record.stock && record.stock.item.id === itemId ? <View style={styles.section} testID="stock-counts">
			<Text style={styles.legend}>Last counts</Text>
			{record.stock.counts.length === 0 ? <Muted>{cardCopy.notCounted}</Muted> : record.stock.counts.map((c) => {
				const at = wordInstant(c.countedAt, record.zone ?? undefined, year);
				return <View key={c.id} testID={`stock-count-row-${c.id}`} style={styles.countRow}>
					<Text style={styles.countText}>{`${countWords(c.count)} ${unit}`}</Text>
					<Muted>{[at ? `${at.day}, ${at.time}` : null, c.countedByName ? `by ${firstName(c.countedByName)}` : null].filter(Boolean).join(' ')}{c.note ? `. ${c.note}` : ''}</Muted>
				</View>;
			})}
		</View> : null}
		<View style={styles.row}>
			<CardButton testID="stock-stocktake-link" label="Stocktake" quiet link onPress={() => router.push('/stock/stocktake' as never)} />
			<View style={{ flex: 1 }} />
			{item ? <CardButton testID={archived ? 'stock-restore' : 'stock-archive'} label={archived ? 'Restore this item' : 'Archive this item'} quiet warn={!archived}
				disabled={locked || archiveBusy || asking || detailBusy || state.busy || state.uncertain} onPress={() => { archiving.clear(); setAsking(true); }} /> : null}
		</View>
		{asking && item ? <View style={styles.box} testID="stock-archive-confirm">
			<Note tone={archived ? 'neutral' : 'warn'}>{archived ? `Restore ${item.name}? It returns to Stocktake and the Stock filter.`
				: `Archive ${item.name}? It leaves Stocktake and the Stock filter. Its counts and this thread stay, and you can restore it from Stocktake’s Show archived.`}</Note>
			<View style={styles.row}>
				<CardButton testID="stock-archive-yes" label={archived ? `Restore ${item.name}` : `Archive ${item.name}`} display={archived ? 'Restore it' : 'Archive it'} primary grow disabled={locked || archiveBusy} onPress={() => archive(!archived)} />
				<CardButton testID="stock-archive-no" label={`Keep ${item.name} as it is`} display="Keep it" disabled={archiveState.busy} onPress={() => { setAsking(false); archiving.clear(); }} />
			</View>
		</View> : null}
		{archiveState.message ? <Text testID="stock-archive-status" role="status" style={archiveState.tone === 'warn' ? styles.warn : styles.ok}>{archiveState.message}</Text> : null}
		{archiveState.uncertain ? <View style={styles.row}>
			<CardButton testID="stock-archive-retry" label="Save again with the same change ID" display="Save again" primary grow disabled={archiveState.busy || archiveWaiting} onPress={() => { void archiving.retry(); }} />
			<CardButton testID="stock-archive-discard" label="Discard this change" display="Discard" disabled={archiveState.busy} onPress={() => archiving.discard()} />
		</View> : null}
	</View>;
}

const useStyles = themedStyles((colors) => ({
	box: { gap: 10 },
	section: { gap: 4 },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	legend: { fontSize: 12, color: colors.muted },
	countRow: { paddingVertical: 6, borderBottomWidth: 1, borderColor: colors.rowLine },
	countText: { fontSize: 15, lineHeight: 21, fontWeight: '600', color: colors.heading },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
