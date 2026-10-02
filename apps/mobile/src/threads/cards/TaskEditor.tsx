/** Design board 1 (Main.dc.html): the unfolded task card. Title, status, owner and due are saved together as one write
 *  and one change set; ticking a step saves at once as its own; "Add a step" adds one. Revision-checked throughout. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import type { ReadScope } from '../../account/contracts.ts';
import type { ThreadCalls } from '../api.ts';
import type { Detail } from '../contracts.ts';
import { themedStyles } from '../../theme/theme.ts';
import { CardButton, Check, DateTimeField, Muted, Note, Segmented, SelectField, TextField, type Option } from './Fields.tsx';
import { send, writes, type Task, type TaskChanges, type TaskStatus } from './records.ts';
import type { RecordState } from './store.ts';
import { useSaver, type CardHooks } from './useSaver.ts';
import { taskForm, taskChanges, validTaskForm, type TaskForm } from './forms.ts';
import { cardCopy } from './copy.ts';

const statusOptions: readonly Option[] = [{ value: 'open', label: 'Open' }, { value: 'in_progress', label: 'In progress' }, { value: 'done', label: 'Done' }];

export function TaskEditor({ calls, scope, detail, record, hooks, locked, confirmed }: {
	calls: ThreadCalls; scope: ReadScope; detail: Detail; record: RecordState; hooks: CardHooks; locked: boolean; confirmed: readonly string[];
}) {
	const styles = useStyles();
	const task = record.task?.task ?? null;
	const [form, setForm] = useState<TaskForm | null>(task ? taskForm(task) : null);
	const [base, setBase] = useState<Task | null>(task);
	// After a save, a stale refusal or a discard, the next task from the server replaces the form.
	const resync = useRef(false);
	const [own] = useState<CardHooks>(() => ({ ...hooks, reload: () => { resync.current = true; hooks.reload(); } }));
	const [fields, fieldState] = useSaver<Task>(own, cardCopy.task, () => { resync.current = true; });
	const [steps, stepState] = useSaver<Task>(hooks, cardCopy.step);
	const [adding, setAdding] = useState<string | null>(null);
	const [ticking, setTicking] = useState<{ id: string; done: boolean } | null>(null);
	// A newer task from the server replaces an untouched form; an edited form keeps the person's values until they save
	// or cancel (a stale save then reloads and says so).
	useEffect(() => {
		if (!task) return;
		if (resync.current || !form || !base || base.revision !== task.revision || base.id !== task.id) {
			if (!form || !base || !taskChanges(base, form) || resync.current) setForm(taskForm(task));
			resync.current = false; setBase(task);
		}
	}, [task]);
	useEffect(() => { fields.confirm(confirmed); steps.confirm(confirmed); }, [confirmed]);
	useEffect(() => { if (stepState.pending === null && !stepState.busy) setTicking(null); }, [stepState.pending, stepState.busy]);

	const members = record.members;
	const ownerOptions = useMemo<Option[]>(() => {
		const rows: Option[] = [{ value: '', label: 'No owner' }, ...(members ?? []).map((m) => ({ value: m.userId, label: m.name || m.email }))];
		if (task?.ownerId && !rows.some((r) => r.value === task.ownerId)) rows.push({ value: task.ownerId, label: `${task.ownerName ?? 'Former member'}${members ? ' (not a member now)' : ''}` });
		return rows;
	}, [members, task?.ownerId, task?.ownerName]);

	if (!task || !form || !base) {
		return <View style={styles.box}>
			{record.message ? <Note tone="warn" testID="card-record-status">{record.message}</Note> : <Muted testID="card-record-loading">{cardCopy.loading}</Muted>}
			<Details detail={detail} />
		</View>;
	}
	const uncertain = fieldState.uncertain, busy = fieldState.busy, waiting = hooks.now() < fieldState.waitUntil;
	const editable = !locked && !busy && !uncertain;
	const changes: TaskChanges | null = taskChanges(base, form);
	const invalid = validTaskForm(form);
	const set = (next: Partial<TaskForm>) => { setForm({ ...form, ...next }); if (!busy && !uncertain) fields.clear(); };
	const save = () => {
		if (!changes || invalid) return;
		void fields.save((id) => { const w = writes.task(scope, task.id, id, base.revision, changes); return { body: w.body, send: () => send(calls, scope, w) }; });
	};
	const stepBusy = stepState.busy || stepState.uncertain || hooks.now() < stepState.waitUntil || locked;
	return <View style={styles.box} testID="task-editor">
		<TextField label="Title" testID="task-title" value={form.title} onChange={(title) => set({ title })} disabled={!editable} maxLength={200} />
		<Segmented label="Status" testID="task-status" value={form.status} options={statusOptions} onChange={(status) => set({ status: status as TaskStatus })} disabled={!editable} />
		{form.status === 'suggested' || form.status === 'cancelled' ? <Muted testID="task-status-note">{form.status === 'cancelled' ? cardCopy.cancelledTask : cardCopy.suggestedTask}</Muted> : null}
		<View style={styles.facts}>
			<SelectField label="Owner" testID="task-owner" value={form.ownerId} options={ownerOptions} onChange={(ownerId) => set({ ownerId })} disabled={!editable || !members} />
			<DateTimeField label="Due" kind="date" testID="task-due" value={form.due} onChange={(due) => set({ due })} disabled={!editable} />
		</View>
		{!members && record.members === null ? <Muted>{cardCopy.membersLoading}</Muted> : null}
		{invalid ? <Muted testID="task-invalid">{invalid}</Muted> : null}
		<View style={styles.row}>
			{uncertain
				? <><CardButton testID="task-retry" label="Save again with the same change ID" display="Save again" primary grow disabled={busy || waiting} onPress={() => { void fields.retry(); }} />
					<CardButton testID="task-discard" label="Discard these changes" display="Discard" disabled={busy} onPress={() => { fields.discard(); setForm(taskForm(task)); setBase(task); }} /></>
				: <><CardButton testID="task-save" label="Save changes" primary grow disabled={!editable || waiting || !changes || Boolean(invalid)} onPress={save} />
					<CardButton testID="task-cancel" label="Cancel" disabled={busy || !changes} onPress={() => { setForm(taskForm(base)); fields.clear(); }} /></>}
		</View>
		{fieldState.message ? <Text testID="task-save-status" role="status" style={fieldState.tone === 'warn' ? styles.warn : styles.ok}>{fieldState.message}</Text> : <Muted testID="task-help">{cardCopy.saveTogether}</Muted>}
		<View testID="task-steps">
			<Text style={styles.legend}>Steps</Text>
			{record.task!.steps.length === 0 ? <Muted>{cardCopy.noSteps}</Muted> : null}
			{record.task!.steps.map((s) => {
				const shown = ticking?.id === s.id ? ticking.done : s.status === 'done';
				return <Check key={s.id} testID={`task-step-${s.id}`} label={s.status === 'cancelled' ? `${s.title} (cancelled)` : s.title} checked={shown} disabled={stepBusy || s.status === 'cancelled'}
					onChange={(done) => { setTicking({ id: s.id, done }); void steps.save((id) => { const w = writes.step(scope, s.id, id, s.revision, done); return { body: w.body, send: () => send(calls, scope, w) }; }); }} />;
			})}
			{record.task!.stepsNext !== null ? <Muted>{cardCopy.moreSteps}</Muted> : null}
			{adding === null
				? <CardButton testID="task-add-step" label="Add a step" quiet disabled={stepBusy} onPress={() => setAdding('')} />
				: <View style={styles.adding}>
					<TextField label="New step" testID="task-new-step" value={adding} onChange={setAdding} disabled={stepBusy} maxLength={200} />
					<View style={styles.row}>
						<CardButton testID="task-add-step-save" label="Add step" primary grow disabled={stepBusy || !adding.trim()} onPress={() => {
							const title = adding.trim();
							void steps.save((id) => { const w = writes.addStep(scope, task.id, id, task.revision, title); return { body: w.body, send: () => send(calls, scope, w) }; }).then(() => { if (!steps.snapshot().pending && steps.snapshot().tone === 'ok') setAdding(null); });
						}} />
						<CardButton testID="task-add-step-cancel" label="Cancel adding a step" display="Cancel" disabled={stepState.busy} onPress={() => setAdding(null)} />
					</View>
				</View>}
			{stepState.message ? <Text testID="task-step-status" role="status" style={stepState.tone === 'warn' ? styles.warn : styles.ok}>{stepState.message}</Text> : null}
			{stepState.uncertain ? <View style={styles.row}>
				<CardButton testID="task-step-retry" label="Save the step again with the same change ID" display="Save again" primary grow disabled={stepState.busy || hooks.now() < stepState.waitUntil} onPress={() => { void steps.retry(); }} />
				<CardButton testID="task-step-discard" label="Discard the step change" display="Discard" disabled={stepState.busy} onPress={() => { steps.discard(); setTicking(null); }} />
			</View> : null}
		</View>
		<Details detail={detail} />
	</View>;
}

/** The fold's read-only remainder: the description and whether evidence is required. */
function Details({ detail }: { detail: Detail }) {
	const f = detail.card.fold;
	const lines = [typeof f.body === 'string' && f.body ? f.body : null, f.evidenceRequired === true ? 'Evidence required' : null].filter(Boolean);
	return lines.length ? <Muted testID="task-details">{lines.join('\n')}</Muted> : null;
}

const useStyles = themedStyles((colors) => ({
	box: { gap: 10 },
	facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
	row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
	legend: { fontSize: 12, color: colors.muted },
	adding: { gap: 8, paddingTop: 6 },
	ok: { fontSize: 13, lineHeight: 18, color: colors.body },
	warn: { fontSize: 13, lineHeight: 18, color: colors.warningText }
}));
