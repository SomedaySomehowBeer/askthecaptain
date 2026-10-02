/** Design board 3 (Topic.dc.html): "Make this a task" on a topic's unfolded card (versions contract §6, decision 4). One
 *  request with the thread's revision and a client change set id, with the card writes' uncertain-write rules: an
 *  uncertain answer locks the form until "Make it again" (the same id and body) or "Discard"; never retried by itself.
 *  On success the same thread reloads as the task's thread. Not offered on a private thread or a record's thread. */
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReadScope } from '../../account/contracts.ts';
import { themedStyles } from '../../theme/theme.ts';
import { threadPath, type ThreadCalls } from '../api.ts';
import type { Detail } from '../contracts.ts';
import { makeTaskBody, parseMadeTask } from './make-task.ts';
import { CardButton, DateTimeField, Muted, SelectField, type Option } from './Fields.tsx';
import { cardCopy } from './copy.ts';
import type { RecordState } from './store.ts';
import { useSaver, type CardHooks } from './useSaver.ts';

export function MakeTask({ calls, scope, detail, record, hooks, locked, confirmed, onMembers, onCancel }: {
	calls: ThreadCalls; scope: ReadScope; detail: Detail; record: RecordState; hooks: CardHooks; locked: boolean; confirmed: readonly string[];
	onMembers: () => void; onCancel: () => void;
}) {
	const styles = useStyles();
	const me = scope.userId;
	const [owner, setOwner] = useState(me);
	const [due, setDue] = useState('');
	const [saver, state] = useSaver<Detail>(hooks, cardCopy.makeTask);
	useEffect(() => { onMembers(); }, []);
	useEffect(() => { saver.confirm(confirmed); }, [confirmed]);
	// Refused because the thread is already a record's: show it as it is now.
	useEffect(() => { if (state.refusal === 'thread_is_record') hooks.reload(); }, [state.refusal]);
	const options = useMemo<Option[]>(() => {
		const members = record.members ?? [];
		const mine = members.find((m) => m.userId === me);
		return [{ value: me, label: `${mine?.name || 'You'}${mine?.name ? ' (you)' : ''}` },
			...members.filter((m) => m.userId !== me).map((m) => ({ value: m.userId, label: m.name || m.email })), { value: '', label: 'No owner' }];
	}, [record.members, me]);
	const busy = state.busy, uncertain = state.uncertain, waiting = hooks.now() < state.waitUntil;
	const editable = !locked && !busy && !uncertain;
	const validDue = due === '' || /^\d{4}-\d{2}-\d{2}$/.test(due);
	const save = () => {
		if (!validDue) return;
		void saver.save((id) => {
			const body = makeTaskBody(id, detail.thread.revision, owner || null, due);
			return { body, send: () => calls.request(scope, 'POST', threadPath(scope, detail.thread.id, 'task'), body, (v) => parseMadeTask(v, detail.thread.id)) };
		});
	};
	return <View testID="make-task" style={styles.box}>
		<Text role="heading" aria-level={2} style={styles.heading}>{cardCopy.makeTaskHeading}</Text>
		<Muted>{cardCopy.makeTaskHelp}</Muted>
		<View style={styles.facts}>
			<SelectField label="Owner" testID="make-task-owner" value={owner} options={options} onChange={setOwner} disabled={!editable} />
			<DateTimeField label="Due (optional)" kind="date" testID="make-task-due" value={due} onChange={setDue} disabled={!editable} required={false} />
		</View>
		{record.members === null ? <Muted>{cardCopy.membersLoading}</Muted> : null}
		{!validDue ? <Muted testID="make-task-invalid">Enter the due date as a date, or leave it empty.</Muted> : null}
		<View style={styles.row}>
			{uncertain
				? <><CardButton testID="make-task-retry" label="Make this a task again with the same change ID" display="Make it again" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
					<CardButton testID="make-task-discard" label="Discard making this a task" display="Discard" disabled={busy} onPress={() => saver.discard()} /></>
				: <><CardButton testID="make-task-save" label="Make this a task" primary grow disabled={!editable || waiting || !validDue} onPress={save} />
					<CardButton testID="make-task-cancel" label="Cancel" disabled={busy} onPress={() => { setOwner(me); setDue(''); saver.clear(); onCancel(); }} /></>}
		</View>
		{state.message ? <Text testID="make-task-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : null}
	</View>;
}

const useStyles = themedStyles((colors) => ({
	box: { gap: 10, borderTopWidth: 1, borderColor: colors.rowLine, paddingTop: 10 },
	heading: { fontSize: 15, fontWeight: '600', color: colors.heading },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
