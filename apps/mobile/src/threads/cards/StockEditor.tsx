/** A stock item's count from its card (versions contract §1, decision 3; not drawn: the task card's pattern with a count
 *  and a note). A count is an observation, not a revision-checked edit: the API records it with who and when. */
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReadScope } from '../../account/contracts.ts';
import type { ThreadCalls } from '../api.ts';
import type { Detail } from '../contracts.ts';
import { themedStyles } from '../../theme/theme.ts';
import { wordInstant } from '../wording.ts';
import { CardButton, Muted, Note, TextField } from './Fields.tsx';
import { validCount } from './forms.ts';
import { send, writes, type Count } from './records.ts';
import { useSaver, type CardHooks } from './useSaver.ts';
import { cardCopy } from './copy.ts';

export function StockEditor({ calls, scope, detail, hooks, locked, confirmed, year }: {
	calls: ThreadCalls; scope: ReadScope; detail: Detail; hooks: CardHooks; locked: boolean; confirmed: readonly string[]; year: number;
}) {
	const styles = useStyles();
	const f = detail.card.fold, itemId = detail.card.record!.id;
	const unit = typeof f.unitLabel === 'string' ? f.unitLabel : '';
	const [count, setCount] = useState(''), [note, setNote] = useState('');
	const [saver, state] = useSaver<Count>(hooks, cardCopy.count, () => { setCount(''); setNote(''); });
	useEffect(() => { saver.confirm(confirmed); }, [confirmed]);
	const archived = f.archivedAt !== null && f.archivedAt !== undefined;
	const counted = typeof f.currentCount === 'string' ? `${f.currentCount}${unit ? ` ${unit}` : ''}` : null;
	const when = typeof f.countedAt === 'string' ? wordInstant(f.countedAt, undefined, year) : null;
	const invalid = count ? validCount(count) : null;
	const waiting = hooks.now() < state.waitUntil;
	const editable = !locked && !archived && !state.busy && !state.uncertain;
	const save = () => {
		if (validCount(count)) return;
		const value = count.trim(), words = note;
		void saver.save((id) => { const w = writes.count(scope, itemId, id, value, words); return { body: w.body, send: () => send(calls, scope, w) }; });
	};
	return <View style={styles.box} testID="stock-editor">
		<Muted testID="stock-last">{counted ? `Last count: ${counted}${when ? `, ${when.day} at ${when.time}` : ''}.` : cardCopy.notCounted}</Muted>
		{archived ? <Note tone="neutral" testID="stock-archived">{cardCopy.archivedStock}</Note> : <>
			<View style={styles.facts}>
				<TextField label={unit ? `Count (${unit})` : 'Count'} testID="stock-count" value={count} onChange={(v) => { setCount(v); if (!state.uncertain) saver.clear(); }} disabled={!editable} keyboard="decimal-pad" maxLength={80} wide={false} />
				<TextField label="Note (optional)" testID="stock-note" value={note} onChange={setNote} disabled={!editable} maxLength={1000} wide={false} />
			</View>
			{invalid ? <Muted testID="stock-invalid">{invalid}</Muted> : null}
			<View style={styles.row}>
				{state.uncertain
					? <><CardButton testID="stock-retry" label="Save the count again with the same change ID" display="Save again" primary grow disabled={state.busy || waiting} onPress={() => { void saver.retry(); }} />
						<CardButton testID="stock-discard" label="Discard this count" display="Discard" disabled={state.busy} onPress={() => { saver.discard(); setCount(''); setNote(''); }} /></>
					: <><CardButton testID="stock-save" label="Save count" primary grow disabled={!editable || waiting || !count.trim() || Boolean(invalid)} onPress={save} />
						<CardButton testID="stock-cancel" label="Cancel" disabled={state.busy || (!count && !note)} onPress={() => { setCount(''); setNote(''); saver.clear(); }} /></>}
			</View>
			{state.message ? <Text testID="stock-save-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : <Muted testID="stock-help">{cardCopy.countHelp}</Muted>}
		</>}
	</View>;
}

const useStyles = themedStyles((colors) => ({
	box: { gap: 10 },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
