/** A tag's details (H4 contract §3), from its row on Tags or its heading's menu on the thread list: name, owner (from the
 *  members), starts and ends, saved together as one revision-checked write and one change set; Archive or Restore after a
 *  confirm step. A stale revision reloads the tag and says so; an uncertain answer keeps the change set id and the exact
 *  body for "Save again with the same ID" or Discard. Board 1's fields; the Equipment screen's card. */
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import { isCanonicalUuid } from '../../api/paths.ts';
import { PlainText, Screen } from '../../components/Screen.tsx';
import type { ThreadCalls } from '../../threads/api.ts';
import { copy } from '../../threads/copy.ts';
import { CardButton, DateTimeField, Muted, Note, SelectField, TextField } from '../../threads/cards/Fields.tsx';
import { send } from '../../threads/cards/records.ts';
import { useSaver, type CardHooks } from '../../threads/cards/useSaver.ts';
import { groupDates } from '../../threads/Presentation.tsx';
import { useDeadline } from '../../threads/use-poll.ts';
import { ownerOptions, useMembers } from '../../resources/tags/members.ts';
import { parseOneTag, tagChanges, tagDetail, tagForm, tagPath, tagProblem, tagsCopy, tagWrites, type ManagedTag, type TagForm } from '../../resources/tags/tags.ts';
import { themedStyles } from '../../theme/theme.ts';
import { faces, type } from '../../theme/tokens.ts';
import Welcome from '../welcome.tsx';

export default function TagPage() {
	const account = useAccount(), view = account.snapshot.account;
	const id = useLocalSearchParams<{ id: string }>().id;
	const back = { label: tagsCopy.heading, onPress: () => { if (router.canGoBack()) router.back(); else router.replace('/tags' as never); } };
	if (view.kind === 'checking' || view.kind === 'starting') return <Screen back={back} title={tagsCopy.detailHeading}><PlainText>{webCopy.checking}</PlainText></Screen>;
	if (view.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(view)) return null;
	if (typeof id !== 'string' || !isCanonicalUuid(id)) return <Screen back={back} title={tagsCopy.detailHeading}><PlainText testID="tag-lost">{tagsCopy.detailLost}</PlainText></Screen>;
	if (!account.web || !view.scope || view.org.kind !== 'chosen') return <Screen back={back} title={tagsCopy.detailHeading}><PlainText>{copy.unavailable}</PlainText></Screen>;
	return <Screen back={back}><TagDetail key={`${view.scope.epoch}:${id}`} calls={account.web.threads} scope={view.scope} id={id} now={account.now} /></Screen>;
}

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; tag: ManagedTag };

function TagDetail({ calls, scope, id, now }: { calls: ThreadCalls; scope: ReadScope; id: string; now: () => number }) {
	const styles = useStyles();
	const [load, setLoad] = useState<Load>({ kind: 'loading' });
	const [lost, setLost] = useState(false);
	const [form, setForm] = useState<TagForm | null>(null);
	const [asking, setAsking] = useState(false);
	const [n, setN] = useState(0);
	const reload = useCallback(() => setN((v) => v + 1), []);
	const members = useMembers(calls, scope);
	useEffect(() => {
		let live = true;
		void calls.request(scope, 'GET', tagPath(scope, id), undefined, (v) => parseOneTag(v, id)).then((r) => {
			if (!live || r.kind === 'stale') return;
			if (r.kind === 'ok') { setLoad({ kind: 'ready', tag: r.value }); setForm(tagForm(r.value)); }
			else if (r.status === 404 || r.status === 403) setLost(true);
			else setLoad({ kind: 'failed', message: r.status === 429 ? tagsCopy.wait : tagsCopy.failed });
		});
		return () => { live = false; };
	}, [n]);
	const [hooks] = useState<CardHooks>(() => ({ now, saved: () => {}, reload: () => {}, lost: () => setLost(true) }));
	const [saver, state] = useSaver<ManagedTag & { changeSetId: string }>({ ...hooks, saved: () => { setAsking(false); reload(); }, reload }, tagsCopy.write);
	const waiting = useDeadline(state.waitUntil, now);
	const busy = state.busy, uncertain = state.uncertain, locked = busy || uncertain || waiting;
	const tag = load.kind === 'ready' ? load.tag : null;
	const names = useMemo(() => new Map((members ?? []).map((m) => [m.userId, m.name || m.email])), [members]);
	if (lost) return <View style={styles.stack}><Text role="heading" style={styles.title}>{tagsCopy.detailHeading}</Text><Note tone="warn" testID="tag-lost">{tagsCopy.detailLost}</Note></View>;
	if (!tag || !form) return <View style={styles.stack}><Text role="heading" style={styles.title}>{tagsCopy.detailHeading}</Text>
		{load.kind === 'failed' ? <><Note tone="warn" testID="tag-failed">{load.message}</Note><CardButton testID="tag-try-again" label="Try again" onPress={reload} /></> : <Text testID="tag-loading" style={styles.body}>{tagsCopy.loading}</Text>}</View>;
	const changes = tagChanges(tag, form), problem = tagProblem(form), archived = tag.archivedAt !== null;
	const set = (next: Partial<TagForm>) => { setForm({ ...form, ...next }); if (!locked) saver.clear(); };
	const run = (patch: Parameters<typeof tagWrites.update>[3]) => { void saver.save((changeSetId) => { const w = tagWrites.update(scope, tag, changeSetId, patch); return { body: w.body, send: () => send(calls, scope, w) }; }); };
	return <View style={styles.stack} testID="tag-detail">
		<Text role="heading" style={styles.title} numberOfLines={2}>{tag.name}</Text>
		<Text testID="tag-summary" style={styles.help}>{tagDetail(tag, tag.ownerId ? names.get(tag.ownerId) ?? (members ? null : '…') : null, groupDates(tag.startsOn, tag.endsOn))}</Text>
		{archived ? <Note tone="neutral" testID="tag-archived">Archived. Its heading is not in the thread list, and it can’t be added to more threads.</Note> : null}
		<View style={styles.card}>
			<TextField label={tagsCopy.name} testID="tag-name" value={form.name} onChange={(name) => set({ name })} disabled={locked} maxLength={120} />
			<SelectField label={tagsCopy.owner} testID="tag-owner" value={form.ownerId} options={ownerOptions(members, tag.ownerId, tag.ownerId ? names.get(tag.ownerId) ?? null : null)} onChange={(ownerId) => set({ ownerId })} disabled={locked} wide />
			<View style={styles.dates}>
				<DateTimeField label={tagsCopy.starts} kind="date" required={false} testID="tag-starts" value={form.startsOn} onChange={(startsOn) => set({ startsOn })} disabled={locked} />
				<DateTimeField label={tagsCopy.ends} kind="date" required={false} testID="tag-ends" value={form.endsOn} onChange={(endsOn) => set({ endsOn })} disabled={locked} />
			</View>
			{form.startsOn || form.endsOn ? <CardButton testID="tag-clear-dates" label="Clear both dates" quiet disabled={locked} onPress={() => set({ startsOn: '', endsOn: '' })} /> : null}
			{problem ? <Muted testID="tag-problem">{problem}</Muted> : null}
			<View style={styles.row}>
				{uncertain
					? <><CardButton testID="tag-retry" label="Save again with the same change ID" display="Save again" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
						<CardButton testID="tag-discard" label="Discard these changes" display="Discard" disabled={busy} onPress={() => { saver.discard(); setForm(tagForm(tag)); }} /></>
					: <><CardButton testID="tag-save" label={tagsCopy.save} primary grow disabled={locked || !changes || Boolean(problem)} onPress={() => { if (changes) run(changes); }} />
						<CardButton testID="tag-cancel" label="Discard your edits" display={tagsCopy.discard} disabled={busy || !changes} onPress={() => { setForm(tagForm(tag)); saver.clear(); }} /></>}
			</View>
			{state.message ? <Text testID="tag-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : <Muted>Name, owner and dates save together as one change.</Muted>}
		</View>
		{asking ? <View style={styles.stack} testID="tag-confirm">
			<Note tone={archived ? 'neutral' : 'warn'}>{archived ? tagsCopy.restoreConfirm(tag.name) : tagsCopy.archiveConfirm(tag.name)}</Note>
			<View style={styles.row}>
				<CardButton testID="tag-confirm-yes" label={`${archived ? 'Restore' : 'Archive'} ${tag.name}`} display={archived ? 'Restore it' : 'Archive it'} primary grow disabled={locked} onPress={() => run({ archived: !archived })} />
				<CardButton testID="tag-confirm-no" label={`Keep ${tag.name} as it is`} display="Keep it" disabled={busy} onPress={() => { setAsking(false); saver.clear(); }} />
			</View>
		</View> : <CardButton testID={archived ? 'tag-restore' : 'tag-archive'} label={archived ? `Restore ${tag.name}` : `Archive ${tag.name}`} display={archived ? 'Restore this tag' : 'Archive this tag'} quiet warn={!archived}
			disabled={locked || Boolean(changes)} onPress={() => { saver.clear(); setAsking(true); }} />}
		{changes && !asking ? <Muted>Save or discard your edits before archiving.</Muted> : null}
	</View>;
}

const useStyles = themedStyles((colors) => ({
	stack: { gap: 10 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	dates: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	title: { fontFamily: faces.display, fontSize: type.heading, lineHeight: type.headingLine, color: colors.heading },
	help: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted, marginTop: -6 },
	card: { gap: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
	body: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
