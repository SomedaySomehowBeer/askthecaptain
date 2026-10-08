/** A series (H4 contract §3), from an occurrence's card ("Part of … · Edit the series"): its title and rule (repeats,
 *  every n months, starting from, when each falls due, owner, evidence) saved together as one revision-checked write, and
 *  Pause or Resume as its own. Changes apply to occurrences made from now on; existing tasks keep what they have (the
 *  API's rule). Board 1's fields; the uncertain-write rules of the card writes. */
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
import { CardButton, Check, DateTimeField, Muted, Note, Segmented, SelectField, TextField } from '../../threads/cards/Fields.tsx';
import { send } from '../../threads/cards/records.ts';
import { useSaver, type CardHooks } from '../../threads/cards/useSaver.ts';
import { useDeadline } from '../../threads/use-poll.ts';
import { ownerOptions, useMembers } from '../../resources/tags/members.ts';
import { dueWords, parseSeries, recurrenceOptions, repeatRule, repeatsWords, seriesChanges, seriesCopy, seriesForm, seriesPath, seriesWrites, shortDate, type RepeatForm, type Series } from '../../resources/series/series.ts';
import { themedStyles } from '../../theme/theme.ts';
import { faces, type } from '../../theme/tokens.ts';
import Welcome from '../welcome.tsx';

export default function SeriesPage() {
	const account = useAccount(), view = account.snapshot.account;
	const id = useLocalSearchParams<{ id: string }>().id;
	const back = { label: 'Back', onPress: () => { if (router.canGoBack()) router.back(); else router.replace('/'); } };
	if (view.kind === 'checking' || view.kind === 'starting') return <Screen back={back} title={seriesCopy.pageHeading}><PlainText>{webCopy.checking}</PlainText></Screen>;
	if (view.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(view)) return null;
	if (typeof id !== 'string' || !isCanonicalUuid(id)) return <Screen back={back} title={seriesCopy.pageHeading}><PlainText testID="series-lost">{seriesCopy.lost}</PlainText></Screen>;
	if (!account.web || !view.scope || view.org.kind !== 'chosen') return <Screen back={back} title={seriesCopy.pageHeading}><PlainText>{copy.unavailable}</PlainText></Screen>;
	return <Screen back={back}><SeriesDetail key={`${view.scope.epoch}:${id}`} calls={account.web.threads} scope={view.scope} id={id} now={account.now} /></Screen>;
}

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'ready'; series: Series };

function SeriesDetail({ calls, scope, id, now }: { calls: ThreadCalls; scope: ReadScope; id: string; now: () => number }) {
	const styles = useStyles();
	const [load, setLoad] = useState<Load>({ kind: 'loading' });
	const [lost, setLost] = useState(false);
	const [form, setForm] = useState<RepeatForm | null>(null);
	const [title, setTitle] = useState('');
	const [n, setN] = useState(0);
	const reload = useCallback(() => setN((v) => v + 1), []);
	const members = useMembers(calls, scope);
	useEffect(() => {
		let live = true;
		void calls.request(scope, 'GET', seriesPath(scope, id), undefined, (v) => parseSeries(v, { id })).then((r) => {
			if (!live || r.kind === 'stale') return;
			if (r.kind === 'ok') { setLoad({ kind: 'ready', series: r.value }); setForm(seriesForm(r.value)); setTitle(r.value.title); }
			else if (r.status === 404 || r.status === 403) setLost(true);
			else setLoad({ kind: 'failed', message: r.status === 429 ? 'Captain asked you to wait before loading this again.' : seriesCopy.seriesFailed });
		});
		return () => { live = false; };
	}, [n]);
	const [hooks] = useState<CardHooks>(() => ({ now, saved: () => {}, reload: () => {}, lost: () => setLost(true) }));
	const [saver, state] = useSaver<Series>({ ...hooks, saved: reload, reload }, seriesCopy.seriesSaved);
	const waiting = useDeadline(state.waitUntil, now);
	const busy = state.busy, uncertain = state.uncertain, locked = busy || uncertain || waiting;
	const series = load.kind === 'ready' ? load.series : null;
	const names = useMemo(() => new Map((members ?? []).map((m) => [m.userId, m.name || m.email])), [members]);
	if (lost) return <View style={styles.stack}><Text role="heading" style={styles.title}>{seriesCopy.pageHeading}</Text><Note tone="warn" testID="series-lost">{seriesCopy.lost}</Note></View>;
	if (!series || !form) return <View style={styles.stack}><Text role="heading" style={styles.title}>{seriesCopy.pageHeading}</Text>
		{load.kind === 'failed' ? <><Note tone="warn" testID="series-failed">{load.message}</Note><CardButton testID="series-try-again" label="Try again" onPress={reload} /></> : <Text testID="series-loading" style={styles.body}>{seriesCopy.loadingSeries}</Text>}</View>;
	const rule = repeatRule(form), error = 'error' in rule ? rule.error : !title.trim() ? 'A title is needed.' : null;
	const changes = 'error' in rule ? null : seriesChanges(series, rule, title);
	const set = (next: Partial<RepeatForm>) => { setForm({ ...form, ...next }); if (!locked) saver.clear(); };
	const run = (patch: Record<string, unknown>) => { void saver.save((changeSetId) => { const w = seriesWrites.update(scope, series, changeSetId, patch); return { body: w.body, send: () => send(calls, scope, w) }; }); };
	const paused = series.pausedAt !== null;
	return <View style={styles.stack} testID="series-detail">
		<Text role="heading" style={styles.title} numberOfLines={3}>{series.title}</Text>
		<Text testID="series-summary" style={styles.help}>{repeatsWords(series)}{series.nextDue ? ` ${seriesCopy.nextDue(series.nextDue)}` : ''}</Text>
		{paused ? <Note tone="neutral" testID="series-paused">{seriesCopy.paused}</Note> : null}
		<View style={styles.card}>
			<TextField label={seriesCopy.title} testID="series-title" value={title} onChange={(v) => { setTitle(v); if (!locked) saver.clear(); }} disabled={locked} maxLength={200} />
			<SelectField label={seriesCopy.recurrence} testID="series-recurrence" value={form.recurrence} options={recurrenceOptions} onChange={(v) => set({ recurrence: v as RepeatForm['recurrence'] })} disabled={locked} wide />
			{form.recurrence === 'custom' ? <TextField label={seriesCopy.every} testID="series-every" value={form.everyMonths} onChange={(everyMonths) => set({ everyMonths })} disabled={locked} keyboard="decimal-pad" maxLength={3} /> : null}
			<View style={styles.facts}>
				<DateTimeField label={seriesCopy.anchor} kind="date" testID="series-anchor" value={form.anchor} onChange={(anchor) => set({ anchor })} disabled={locked} />
				<TextField label={seriesCopy.dueDays} testID="series-due-days" value={form.dueDays} onChange={(dueDays) => set({ dueDays })} disabled={locked} keyboard="decimal-pad" maxLength={3} wide={false} />
			</View>
			<Segmented label={seriesCopy.due} testID="series-due-when" value={form.dueWhen} options={[{ value: 'before', label: 'Before the end' }, { value: 'after', label: 'After the end' }]} onChange={(v) => set({ dueWhen: v as 'after' | 'before' })} disabled={locked} />
			{'error' in rule ? null : <Muted testID="series-due-words">{`Each one is ${dueWords(rule.dueOffsetDays, rule.recurrence)}.`}</Muted>}
			<SelectField label={seriesCopy.owner} testID="series-owner" value={form.ownerId} options={ownerOptions(members, series.ownerId, series.ownerId ? names.get(series.ownerId) ?? null : null)} onChange={(ownerId) => set({ ownerId })} disabled={locked} wide />
			<Check label={seriesCopy.evidence} testID="series-evidence" checked={form.evidenceRequired} onChange={(evidenceRequired) => set({ evidenceRequired })} disabled={locked} />
			{error ? <Muted testID="series-problem">{error}</Muted> : <Muted>{seriesCopy.futureOnly}</Muted>}
			<View style={styles.row}>
				{uncertain
					? <><CardButton testID="series-retry" label="Save again with the same change ID" display="Save again" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
						<CardButton testID="series-discard" label="Discard these changes" display="Discard" disabled={busy} onPress={() => { saver.discard(); setForm(seriesForm(series)); setTitle(series.title); }} /></>
					: <><CardButton testID="series-save" label="Save changes" primary grow disabled={locked || !changes || Boolean(error)} onPress={() => { if (changes) run(changes); }} />
						<CardButton testID="series-cancel" label="Discard your edits" display="Discard edits" disabled={busy || !changes} onPress={() => { setForm(seriesForm(series)); setTitle(series.title); saver.clear(); }} /></>}
			</View>
			{state.message ? <Text testID="series-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : null}
		</View>
		<CardButton testID={paused ? 'series-resume' : 'series-pause'} label={paused ? `${seriesCopy.resume} ${series.title}` : `${seriesCopy.pause} ${series.title}`} display={paused ? seriesCopy.resume : seriesCopy.pause}
			primary={paused} disabled={locked || Boolean(changes)} onPress={() => run({ paused: !paused })} />
		{changes ? <Muted>Save or discard your edits before pausing or resuming.</Muted> : <Muted>{paused ? 'Resuming makes this period’s task if it is missing.' : `Pausing stops new occurrences; the next would be due ${series.nextDue ? shortDate(series.nextDue) : 'later'}.`}</Muted>}
	</View>;
}

const useStyles = themedStyles((colors) => ({
	stack: { gap: 10 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	title: { fontFamily: faces.display, fontSize: type.heading, lineHeight: type.headingLine, color: colors.heading },
	help: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted, marginTop: -6 },
	card: { gap: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
	body: { fontSize: type.small, lineHeight: type.smallLine, color: colors.body },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
