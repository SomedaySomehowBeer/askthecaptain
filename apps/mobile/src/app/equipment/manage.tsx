/** The Equipment screen (bookings contract §3), from the schedule's "Manage equipment": the active list, or the archived
 *  one with "Show archived"; "Add equipment" by name; rename in place; archive and unarchive, each after a confirm step.
 *  Every write is one revision-checked, journalled request with a client change set id (versions contract §5), with the
 *  card writes' uncertain-write rules: an uncertain answer locks the screen's writes until "Save again with the same ID"
 *  or "Discard"; nothing is retried by itself. Archived equipment leaves the schedule and the pickers. The list follows
 *  the Members screen's (prototype frame 12): a spaced-capital section label over one card of rows. */
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import { PlainText, Screen } from '../../components/Screen.tsx';
import type { ThreadCalls } from '../../threads/api.ts';
import { copy } from '../../threads/copy.ts';
import { CardButton, Muted, Note, TextField } from '../../threads/cards/Fields.tsx';
import { send } from '../../threads/cards/records.ts';
import { useSaver, type CardHooks } from '../../threads/cards/useSaver.ts';
import { useDeadline } from '../../threads/use-poll.ts';
import { equipmentListPath, equipmentNameProblem, equipmentRefusals, equipmentWrites, parseEquipmentList, type EquipmentList, type ManagedEquipment } from '../../resources/equipment/manage.ts';
import { themedStyles } from '../../theme/theme.ts';
import { type } from '../../theme/tokens.ts';
import Welcome from '../welcome.tsx';

const manageCopy = {
	heading: 'Equipment',
	help: 'Shared equipment people can book. Archived equipment leaves the schedule and the booking forms; its past bookings stay in their threads.',
	section: 'Active equipment',
	archivedSection: 'Archived equipment',
	loading: 'Loading the equipment…',
	failed: 'Couldn’t load the equipment. Try again.',
	wait: 'Captain asked you to wait before loading this again.',
	lost: 'This organisation’s equipment is no longer available to you.',
	empty: 'No equipment yet. Add the first below.',
	emptyArchived: 'No archived equipment.',
	more: 'Only the first 100 are shown.',
	add: 'Add equipment', addHeading: 'Add equipment', name: 'Name',
	write: { saving: 'Saving…', saved: 'Saved. The change is in the equipment’s history.', confirmed: 'Change confirmed.', refusals: equipmentRefusals },
	archiveConfirm: (name: string) => `Archive ${name}? It leaves the schedule and the booking forms. Its past bookings stay in their threads. You can unarchive it later.`,
	unarchiveConfirm: (name: string) => `Unarchive ${name}? It returns to the schedule and the booking forms.`
} as const;

export default function ManageEquipmentPage() {
	const account = useAccount(), view = account.snapshot.account;
	const back = { label: 'Equipment schedule', onPress: () => { if (router.canGoBack()) router.back(); else router.replace('/equipment'); } };
	if (view.kind === 'checking' || view.kind === 'starting') return <Screen back={back} title={manageCopy.heading}><PlainText>{webCopy.checking}</PlainText></Screen>;
	if (view.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(view)) return null;
	if (!account.web || !view.scope || view.org.kind !== 'chosen') return <Screen back={back} title={manageCopy.heading}><PlainText>{copy.unavailable}</PlainText></Screen>;
	return <Screen back={back} title={manageCopy.heading}><ManageEquipment key={view.scope.epoch} calls={account.web.threads} scope={view.scope} now={account.now} /></Screen>;
}

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; list: EquipmentList };
type Asking = { id: string; action: 'rename' | 'archive' | 'unarchive' } | null;

function ManageEquipment({ calls, scope, now }: { calls: ThreadCalls; scope: ReadScope; now: () => number }) {
	const styles = useStyles();
	const [archived, setArchived] = useState(false);
	const [load, setLoad] = useState<Load>({ kind: 'loading' });
	const [lost, setLost] = useState(false);
	const [asking, setAsking] = useState<Asking>(null);
	const [draft, setDraft] = useState('');
	const [adding, setAdding] = useState('');
	const [n, setN] = useState(0);
	const reload = useCallback(() => setN((v) => v + 1), []);
	useEffect(() => {
		let live = true;
		setLoad((l) => l.kind === 'ready' && l.list.archived === archived ? l : { kind: 'loading' });
		void calls.request(scope, 'GET', equipmentListPath(scope, archived), undefined, (v) => parseEquipmentList(v, archived)).then((r) => {
			if (!live || r.kind === 'stale') return;
			if (r.kind === 'ok') setLoad({ kind: 'ready', list: r.value });
			else if (r.status === 404 || r.status === 403) setLost(true);
			else setLoad({ kind: 'failed', message: r.status === 429 ? manageCopy.wait : manageCopy.failed });
		});
		return () => { live = false; };
	}, [archived, n]);
	const [hooks] = useState<CardHooks>(() => ({ now, saved: () => {}, reload: () => {}, lost: () => setLost(true) }));
	const [saver, state] = useSaver<ManagedEquipment & { changeSetId: string }>({ ...hooks, saved: () => { setAsking(null); setAdding(''); reload(); }, reload }, manageCopy.write);
	const waiting = useDeadline(state.waitUntil, now);
	const busy = state.busy, uncertain = state.uncertain;
	const locked = busy || uncertain || waiting;
	const addProblem = adding ? equipmentNameProblem(adding) : null;
	const run = (build: (changeSetId: string) => ReturnType<typeof equipmentWrites.add>) => {
		void saver.save((changeSetId) => { const w = build(changeSetId); return { body: w.body, send: () => send(calls, scope, w) }; });
	};
	if (lost) return <Note tone="warn" testID="equipment-manage-lost">{manageCopy.lost}</Note>;
	const rows = load.kind === 'ready' ? load.list.equipment : [];
	return <View style={styles.stack} testID="equipment-manage">
		<Text style={styles.help}>{manageCopy.help}</Text>
		<View style={styles.row}>
			<CardButton testID="equipment-manage-show-archived" label={archived ? 'Show active equipment' : 'Show archived'} disabled={busy} onPress={() => { setAsking(null); setArchived(!archived); }} />
			<View style={styles.grow} />
			<CardButton testID="equipment-manage-refresh" label="Refresh" quiet disabled={busy} onPress={reload} />
		</View>
		{state.message ? <Text testID="equipment-manage-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : null}
		{uncertain ? <View style={styles.row}>
			<CardButton testID="equipment-manage-retry" label="Save again with the same change ID" display="Save again with the same ID" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
			<CardButton testID="equipment-manage-discard" label="Discard this change" display="Discard" disabled={busy} onPress={() => saver.discard()} />
		</View> : null}
		<Text role="heading" style={styles.section}>{archived ? manageCopy.archivedSection : manageCopy.section}</Text>
		{load.kind === 'loading' ? <Text testID="equipment-manage-loading" style={styles.body}>{manageCopy.loading}</Text> : null}
		{load.kind === 'failed' ? <View style={styles.stack}><Note tone="warn" testID="equipment-manage-failed">{load.message}</Note>
			<CardButton testID="equipment-manage-try-again" label="Try again" onPress={reload} /></View> : null}
		{load.kind === 'ready' && rows.length === 0 ? <Text testID="equipment-manage-empty" style={styles.body}>{archived ? manageCopy.emptyArchived : manageCopy.empty}</Text> : null}
		{rows.length ? <View style={styles.list}>{rows.map((item, i) => {
			const mine = asking?.id === item.id ? asking.action : null;
			const renameProblem = mine === 'rename' ? equipmentNameProblem(draft) : null;
			return <View key={item.id} testID={`equipment-row-${item.id}`} style={[styles.item, i > 0 && styles.divided]}>
				{mine === 'rename' ? <View style={styles.stack}>
					<TextField label={`New name for ${item.name}`} testID={`equipment-rename-input-${item.id}`} value={draft} onChange={(v) => { setDraft(v); if (!locked) saver.clear(); }} disabled={locked} maxLength={100} />
					{renameProblem && draft ? <Muted>{renameProblem}</Muted> : null}
					<View style={styles.row}>
						<CardButton testID={`equipment-rename-save-${item.id}`} label={`Save the name for ${item.name}`} display="Save name" primary grow disabled={locked || Boolean(renameProblem) || draft.trim() === item.name}
							onPress={() => run((id) => equipmentWrites.rename(scope, item, id, draft))} />
						<CardButton testID={`equipment-rename-cancel-${item.id}`} label="Cancel renaming" display="Cancel" disabled={busy} onPress={() => { setAsking(null); saver.clear(); }} />
					</View>
				</View> : <View style={styles.line}>
					<View style={styles.who}><Text style={styles.name} numberOfLines={2}>{item.name}</Text>
						<Text style={styles.detail}>{item.archivedAt ? 'Archived' : 'Active'}</Text></View>
					{item.archivedAt ? null : <CardButton testID={`equipment-rename-${item.id}`} label={`Rename ${item.name}`} display="Rename" quiet disabled={locked || asking !== null}
						onPress={() => { saver.clear(); setDraft(item.name); setAsking({ id: item.id, action: 'rename' }); }} />}
					<View style={{ width: 14 }} />
					<CardButton testID={`equipment-${item.archivedAt ? 'unarchive' : 'archive'}-${item.id}`} label={`${item.archivedAt ? 'Unarchive' : 'Archive'} ${item.name}`} display={item.archivedAt ? 'Unarchive' : 'Archive'}
						quiet warn={!item.archivedAt} disabled={locked || asking !== null} onPress={() => { saver.clear(); setAsking({ id: item.id, action: item.archivedAt ? 'unarchive' : 'archive' }); }} />
				</View>}
				{mine === 'archive' || mine === 'unarchive' ? <View style={styles.stack} testID={`equipment-confirm-${item.id}`}>
					<Note tone={mine === 'archive' ? 'warn' : 'neutral'}>{mine === 'archive' ? manageCopy.archiveConfirm(item.name) : manageCopy.unarchiveConfirm(item.name)}</Note>
					<View style={styles.row}>
						<CardButton testID={`equipment-confirm-yes-${item.id}`} label={`${mine === 'archive' ? 'Archive' : 'Unarchive'} ${item.name}`} display={mine === 'archive' ? 'Archive it' : 'Unarchive it'} primary grow disabled={locked}
							onPress={() => run((id) => equipmentWrites.archive(scope, item, id, mine === 'archive'))} />
						<CardButton testID={`equipment-confirm-no-${item.id}`} label={`Keep ${item.name} as it is`} display="Keep it" disabled={busy} onPress={() => { setAsking(null); saver.clear(); }} />
					</View>
				</View> : null}
			</View>;
		})}</View> : null}
		{load.kind === 'ready' && load.list.more ? <Muted>{manageCopy.more}</Muted> : null}
		{archived ? null : <View style={styles.card} testID="equipment-add">
			<Text role="heading" style={styles.heading}>{manageCopy.addHeading}</Text>
			<TextField label={manageCopy.name} testID="equipment-add-name" value={adding} onChange={(v) => { setAdding(v); if (!locked) saver.clear(); }} disabled={locked} maxLength={100} placeholder="Fermenter 3" />
			{addProblem ? <Muted>{addProblem}</Muted> : null}
			<CardButton testID="equipment-add-save" label={manageCopy.add} primary disabled={locked || !adding.trim() || Boolean(addProblem) || asking !== null} onPress={() => run((id) => equipmentWrites.add(scope, id, adding))} />
		</View>}
	</View>;
}

/** Prototype frame 12 (Team), as the Members screen: spaced-capital section labels, one white card of rows split by hairlines,
 *  13 pt bold names over 11 pt details; the controls are the cards' (R3 buttons and fields). */
const useStyles = themedStyles((colors) => ({
	stack: { gap: 10 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	grow: { flex: 1 },
	help: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted },
	section: { fontSize: type.section, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: colors.muted, marginTop: 8 },
	list: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.card, overflow: 'hidden' },
	item: { paddingHorizontal: 12, paddingVertical: 6, gap: 8 },
	divided: { borderTopWidth: 1, borderColor: colors.rowLine },
	line: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
	who: { flex: 1, minWidth: 0 },
	name: { fontSize: type.rowTitle, lineHeight: type.rowTitleLine, fontWeight: '700', color: colors.heading },
	detail: { fontSize: type.rowDetail, lineHeight: type.rowDetailLine, color: colors.muted },
	card: { gap: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
	heading: { fontSize: type.body, fontWeight: '700', color: colors.heading },
	body: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
