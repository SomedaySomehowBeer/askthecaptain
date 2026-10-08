/** "Repeat this task" on a task's unfolded card (H4 contract §3; board 1's fields): a form in place for the rule (repeats,
 *  every n months when custom, starting from, when it falls due, owner, evidence) that makes a series from the task with
 *  its title, body and tags; the task becomes the series' occurrence for its period. A task that is already part of a
 *  series shows "Part of <series> · Edit the series" instead. One revision-checked write with a client change set id and
 *  the card writes' uncertain rules (an uncertain answer keeps the id and the exact body for "Save again"). */
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReadScope } from '../../account/contracts.ts';
import type { ThreadCalls } from '../api.ts';
import type { Detail } from '../contracts.ts';
import { themedStyles } from '../../theme/theme.ts';
import { type } from '../../theme/tokens.ts';
import { useDeadline } from '../use-poll.ts';
import { CardButton, Check, DateTimeField, Muted, Segmented, SelectField, TextField, type Option } from './Fields.tsx';
import { send } from './records.ts';
import type { RecordState } from './store.ts';
import { useSaver, type CardHooks } from './useSaver.ts';
import { dueWords, firstPeriod, recurrenceOptions, repeatForm, repeatRule, repeatsWords, seriesCopy, seriesWrites, type RepeatForm, type Series } from '../../resources/series/series.ts';
import { refusedForGood } from './forms.ts';

export function RepeatTask({ calls, scope, detail, record, hooks, locked, confirmed, ownerOptions }: {
	calls: ThreadCalls; scope: ReadScope; detail: Detail; record: RecordState; hooks: CardHooks; locked: boolean; confirmed: readonly string[]; ownerOptions: readonly Option[];
}) {
	const styles = useStyles();
	const task = record.task!.task, today = record.task!.today, series = record.task!.series;
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<RepeatForm>(() => repeatForm(task, today));
	const [made, setMade] = useState<Series | null>(null);
	const [saver, state] = useSaver<Series>(hooks, seriesCopy.write, (value) => { if (value) setMade(value); setOpen(false); });
	useEffect(() => { saver.confirm(confirmed); }, [confirmed]);
	const waiting = useDeadline(state.waitUntil, hooks.now);
	const rule = useMemo(() => repeatRule(form), [form]);
	const busy = state.busy, uncertain = state.uncertain, editable = !locked && !busy && !uncertain;
	const set = (next: Partial<RepeatForm>) => { setForm({ ...form, ...next }); if (editable) saver.clear(); };
	if (series) return <View style={styles.box} testID="task-series">
		{made ? <Text testID="task-repeats" role="status" style={styles.ok}>{repeatsWords(made)}</Text> : null}
		<View style={styles.line}><Text style={styles.part} numberOfLines={2}>{seriesCopy.partOf(series.title)}</Text><Text style={styles.dot}> · </Text>
			<CardButton testID="task-series-edit" label={seriesCopy.edit} quiet link onPress={() => router.push(`/series/${series.id}` as never)} /></View>
	</View>;
	if (!open && !uncertain) return <View style={styles.box}>
		{state.message && state.tone === 'warn' ? <Text testID="task-repeat-status" role="status" style={styles.warn}>{state.message}</Text> : null}
		<CardButton testID="task-repeat-open" label={seriesCopy.open} quiet disabled={locked || refusedForGood(state.refusal)} onPress={() => { setForm(repeatForm(task, today)); saver.clear(); setOpen(true); }} />
	</View>;
	const error = 'error' in rule ? rule.error : null;
	const period = error === null && !('error' in rule) ? firstPeriod(rule, today) : null;
	return <View style={styles.form} testID="task-repeat">
		<Text role="heading" style={styles.heading}>{seriesCopy.heading}</Text>
		<SelectField label={seriesCopy.recurrence} testID="task-repeat-recurrence" value={form.recurrence} options={recurrenceOptions} onChange={(v) => set({ recurrence: v as RepeatForm['recurrence'] })} disabled={!editable} wide />
		{form.recurrence === 'custom' ? <TextField label={seriesCopy.every} testID="task-repeat-every" value={form.everyMonths} onChange={(everyMonths) => set({ everyMonths })} disabled={!editable} keyboard="decimal-pad" maxLength={3} /> : null}
		<View style={styles.facts}>
			<DateTimeField label={seriesCopy.anchor} kind="date" testID="task-repeat-anchor" value={form.anchor} onChange={(anchor) => set({ anchor })} disabled={!editable} />
			<TextField label={seriesCopy.dueDays} testID="task-repeat-due-days" value={form.dueDays} onChange={(dueDays) => set({ dueDays })} disabled={!editable} keyboard="decimal-pad" maxLength={3} wide={false} />
		</View>
		<Segmented label={seriesCopy.due} testID="task-repeat-due-when" value={form.dueWhen} options={[{ value: 'before', label: 'Before the end' }, { value: 'after', label: 'After the end' }]}
			onChange={(v) => set({ dueWhen: v as 'after' | 'before' })} disabled={!editable} />
		{error === null && !('error' in rule) ? <Muted testID="task-repeat-due-words">{`Each one is ${dueWords(rule.dueOffsetDays, rule.recurrence)}.`}</Muted> : null}
		<SelectField label={seriesCopy.owner} testID="task-repeat-owner" value={form.ownerId} options={ownerOptions} onChange={(ownerId) => set({ ownerId })} disabled={!editable} wide />
		<Check label={seriesCopy.evidence} testID="task-repeat-evidence" checked={form.evidenceRequired} onChange={(evidenceRequired) => set({ evidenceRequired })} disabled={!editable} />
		{error ? <Muted testID="task-repeat-problem">{error}</Muted> : period ? <Muted testID="task-repeat-period">{seriesCopy.thisOccurrence(period.start, period.end)}{detail.tags.length ? ` It keeps this task’s tags: ${detail.tags.map((t) => t.name).join(', ')}.` : ''}</Muted> : null}
		<View style={styles.row}>
			{uncertain
				? <><CardButton testID="task-repeat-retry" label="Save again with the same change ID" display="Save again" primary grow disabled={busy || waiting} onPress={() => { void saver.retry(); }} />
					<CardButton testID="task-repeat-discard" label="Discard this repeat" display="Discard" disabled={busy} onPress={() => { saver.discard(); setOpen(false); }} /></>
				: <><CardButton testID="task-repeat-save" label={seriesCopy.save} primary grow disabled={!editable || waiting || Boolean(error) || refusedForGood(state.refusal)}
						onPress={() => { if ('error' in rule) return; void saver.save((id) => { const w = seriesWrites.repeat(scope, task, detail.tags.map((t) => t.id), rule, id); return { body: w.body, send: () => send(calls, scope, w) }; }); }} />
					<CardButton testID="task-repeat-cancel" label="Cancel repeating this task" display={seriesCopy.cancel} disabled={busy} onPress={() => { setOpen(false); saver.clear(); }} /></>}
		</View>
		{state.message ? <Text testID="task-repeat-status" role="status" style={state.tone === 'warn' ? styles.warn : styles.ok}>{state.message}</Text> : null}
	</View>;
}

const useStyles = themedStyles((colors) => ({
	box: { gap: 6 },
	form: { gap: 10, paddingTop: 8, borderTopWidth: 1, borderColor: colors.rowLine },
	heading: { fontSize: type.body, fontWeight: '700', color: colors.heading },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
	part: { flexShrink: 1, fontSize: type.small, lineHeight: type.smallLine, color: colors.body },
	dot: { fontSize: type.small, color: colors.muted },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
