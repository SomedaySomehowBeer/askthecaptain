/** Tags (H4 contract §3), from "Manage tags" in the thread list's filter-row menu or a tag heading's menu: every tag in
 *  name order with its owner and dates when set and how many threads the person can see carry it; "Show archived";
 *  "Add a tag" by name with an optional owner and dates. A row opens the tag's details (`/tags/[id]`), where it is renamed,
 *  given an owner and dates, archived or restored. Every write is one revision-checked, journalled request with a client
 *  change set id, with the card writes' uncertain-write rules. The list follows the Equipment screen (H2), itself frame 12's
 *  Members layout: a spaced-capital section label over one card of rows; the fields are board 1's. */
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAccount } from '../../account/AccountProvider.tsx';
import type { ReadScope } from '../../account/contracts.ts';
import { isSignedIn, webCopy } from '../../account/copy.ts';
import { ChevronRight } from '../../components/Icons.tsx';
import { PlainText, Screen } from '../../components/Screen.tsx';
import type { ThreadCalls } from '../../threads/api.ts';
import { copy } from '../../threads/copy.ts';
import { CardButton, DateTimeField, Muted, Note, SelectField, TextField } from '../../threads/cards/Fields.tsx';
import { ownerOptions, useMembers } from '../../resources/tags/members.ts';
import { send } from '../../threads/cards/records.ts';
import { useSaver, type CardHooks } from '../../threads/cards/useSaver.ts';
import { groupDates } from '../../threads/Presentation.tsx';
import { useDeadline } from '../../threads/use-poll.ts';
import { emptyTagForm, parseTagCatalogue, tagCataloguePath, tagDetail, tagProblem, tagsCopy, tagWrites, type ManagedTag, type TagCatalogue, type TagForm } from '../../resources/tags/tags.ts';
import { themedStyles, useTheme } from '../../theme/theme.ts';
import { type } from '../../theme/tokens.ts';
import Welcome from '../welcome.tsx';

export default function TagsPage() {
	const account = useAccount(), view = account.snapshot.account;
	const back = { label: 'Threads', onPress: () => { if (router.canGoBack()) router.back(); else router.replace('/'); } };
	if (view.kind === 'checking' || view.kind === 'starting') return <Screen back={back} title={tagsCopy.heading}><PlainText>{webCopy.checking}</PlainText></Screen>;
	if (view.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(view)) return null;
	if (!account.web || !view.scope || view.org.kind !== 'chosen') return <Screen back={back} title={tagsCopy.heading}><PlainText>{copy.unavailable}</PlainText></Screen>;
	return <Screen back={back} title={tagsCopy.heading}><ManageTags key={view.scope.epoch} calls={account.web.threads} scope={view.scope} now={account.now} /></Screen>;
}

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; list: TagCatalogue };

function ManageTags({ calls, scope, now }: { calls: ThreadCalls; scope: ReadScope; now: () => number }) {
	const styles = useStyles();
	const { colors } = useTheme();
	const [archived, setArchived] = useState(false);
	const [load, setLoad] = useState<Load>({ kind: 'loading' });
	const [lost, setLost] = useState(false);
	const [form, setForm] = useState<TagForm>(emptyTagForm);
	const [adding, setAdding] = useState(false);
	const [n, setN] = useState(0);
	const reload = useCallback(() => setN((v) => v + 1), []);
	const members = useMembers(calls, scope);
	useEffect(() => {
		let live = true;
		void calls.request(scope, 'GET', tagCataloguePath(scope), undefined, parseTagCatalogue).then((r) => {
			if (!live || r.kind === 'stale') return;
			if (r.kind === 'ok') setLoad({ kind: 'ready', list: r.value });
			else if (r.status === 404 || r.status === 403) setLost(true);
			else setLoad({ kind: 'failed', message: r.status === 429 ? tagsCopy.wait : tagsCopy.failed });
		});
		return () => { live = false; };
	}, [n]);
	const [hooks] = useState<CardHooks>(() => ({ now, saved: () => {}, reload: () => {}, lost: () => setLost(true) }));
	const [saver, state] = useSaver<ManagedTag & { changeSetId: string }>({ ...hooks, saved: () => { setForm(emptyTagForm); setAdding(false); reload(); }, reload }, tagsCopy.write);
	const waiting = useDeadline(state.waitUntil, now);
	const busy = state.busy, uncertain = state.uncertain, locked = busy || uncertain || waiting;
	const problem = form.name ? tagProblem(form) : null;
	const names = useMemo(() => new Map((members ?? []).map((m) => [m.userId, m.name || m.email])), [members]);
	if (lost) return <Note tone="warn" testID="tags-lost">{tagsCopy.lost}</Note>;
	const rows = load.kind === 'ready' ? load.list.tags.filter((t) => (t.archivedAt !== null) === archived) : [];
	const set = (next: Partial<TagForm>) => { setForm({ ...form, ...next }); if (!locked) saver.clear(); };
	return <View style={styles.stack} testID="tags-manage">
		<Text style={styles.help}>{tagsCopy.help}</Text>
		<View style={styles.row}>
			<CardButton testID="tags-show-archived" label={archived ? 'Show active tags' : 'Show archived'} disabled={busy} onPress={() => setArchived(!archived)} />
			<View style={styles.grow} />
			<CardButton testID="tags-refresh" label="Refresh" quiet disabled={busy} onPress={reload} />
		</View>
		{state.message ? <Text testID="tags-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : null}
		{uncertain ? <View style={styles.row}>
			<CardButton testID="tags-retry" label="Save again with the same change ID" display="Save again with the same ID" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
			<CardButton testID="tags-discard" label="Discard this change" display="Discard" disabled={busy} onPress={() => saver.discard()} />
		</View> : null}
		<Text role="heading" style={styles.section}>{archived ? tagsCopy.archivedSection : tagsCopy.section}</Text>
		{load.kind === 'loading' ? <Text testID="tags-loading" style={styles.body}>{tagsCopy.loading}</Text> : null}
		{load.kind === 'failed' ? <View style={styles.stack}><Note tone="warn" testID="tags-failed">{load.message}</Note>
			<CardButton testID="tags-try-again" label="Try again" onPress={reload} /></View> : null}
		{load.kind === 'ready' && rows.length === 0 ? <Text testID="tags-empty" style={styles.body}>{archived ? 'No archived tags.' : tagsCopy.empty}</Text> : null}
		{rows.length ? <View style={styles.list}>{rows.map((tag, i) => (
			<Pressable key={tag.id} testID={`tag-row-${tag.id}`} role="link" aria-label={`${tag.name}. ${tagDetail(tag, tag.ownerId ? names.get(tag.ownerId) ?? null : null, groupDates(tag.startsOn, tag.endsOn))}`}
				onPress={() => router.push(`/tags/${tag.id}` as never)} style={[styles.item, i > 0 && styles.divided]}>
				<View style={styles.who}><Text style={styles.name} numberOfLines={2}>{tag.name}</Text>
					<Text style={styles.detail} numberOfLines={2}>{tagDetail(tag, tag.ownerId ? names.get(tag.ownerId) ?? (members ? null : '…') : null, groupDates(tag.startsOn, tag.endsOn))}</Text></View>
				<ChevronRight color={colors.muted} />
			</Pressable>))}</View> : null}
		{load.kind === 'ready' ? <Muted>{load.list.more ? `${tagsCopy.more} ${tagsCopy.countsNote}` : tagsCopy.countsNote}</Muted> : null}
		{archived ? null : adding ? <View style={styles.card} testID="tags-add">
			<Text role="heading" style={styles.heading}>{tagsCopy.addHeading}</Text>
			<TextField label={tagsCopy.name} testID="tags-add-name" value={form.name} onChange={(name) => set({ name })} disabled={locked} maxLength={120} placeholder="Summer lager launch" />
			<SelectField label={tagsCopy.owner} testID="tags-add-owner" value={form.ownerId} options={ownerOptions(members, null, null)} onChange={(ownerId) => set({ ownerId })} disabled={locked} wide />
			<View style={styles.dates}>
				<DateTimeField label={tagsCopy.starts} kind="date" required={false} testID="tags-add-starts" value={form.startsOn} onChange={(startsOn) => set({ startsOn })} disabled={locked} />
				<DateTimeField label={tagsCopy.ends} kind="date" required={false} testID="tags-add-ends" value={form.endsOn} onChange={(endsOn) => set({ endsOn })} disabled={locked} />
			</View>
			{problem ? <Muted testID="tags-add-problem">{problem}</Muted> : null}
			<View style={styles.row}>
				<CardButton testID="tags-add-save" label={tagsCopy.add} primary grow disabled={locked || !form.name.trim() || Boolean(problem)}
					onPress={() => { void saver.save((id) => { const w = tagWrites.add(scope, id, form); return { body: w.body, send: () => send(calls, scope, w) }; }); }} />
				<CardButton testID="tags-add-cancel" label="Cancel adding a tag" display="Cancel" disabled={busy} onPress={() => { setAdding(false); setForm(emptyTagForm); saver.clear(); }} />
			</View>
		</View> : <CardButton testID="tags-add-open" label={tagsCopy.add} disabled={locked} onPress={() => { saver.clear(); setAdding(true); }} />}
	</View>;
}

/** The Equipment screen's styles (H2; prototype frame 12): spaced-capital section labels, one white card of rows split by
 *  hairlines, 13 pt bold names over 11 pt details; board 1's fields and buttons. */
const useStyles = themedStyles((colors) => ({
	stack: { gap: 10 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	grow: { flex: 1 },
	dates: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	help: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted },
	section: { fontSize: type.section, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase', color: colors.muted, marginTop: 8 },
	list: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, backgroundColor: colors.card, overflow: 'hidden' },
	item: { paddingHorizontal: 12, paddingVertical: 8, minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 8 },
	divided: { borderTopWidth: 1, borderColor: colors.rowLine },
	who: { flex: 1, minWidth: 0 },
	name: { fontSize: type.rowTitle, lineHeight: type.rowTitleLine, fontWeight: '700', color: colors.heading },
	detail: { fontSize: type.rowDetail, lineHeight: type.rowDetailLine, color: colors.muted },
	card: { gap: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
	heading: { fontSize: type.body, fontWeight: '700', color: colors.heading },
	body: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
