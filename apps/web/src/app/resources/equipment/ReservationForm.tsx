'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition, type FormEvent } from 'react';
import { checkReservation, createReservation, replaceReservation, type Outcome } from './actions.ts';
import { localChoices, localValue } from './time.ts';
import type { Reservation } from './types.ts';

export type Choice = { id: string; label: string };
export type TaskChoice = Choice & { projectId: string };
/** Options come from existing lookups. `null` means that lookup failed: the form then keeps any
 *  current value unchanged instead of offering (and silently clearing) an incomplete list. */
export type ReservationOptions = { people: Choice[] | null; projects: Choice[] | null; tasks: TaskChoice[] | null };
type Values = { title: string; kind: 'booking' | 'maintenance'; startsLocal: string; endsLocal: string; setupMinutes: number; cleanupMinutes: number;
	projectId: string | null; taskId: string | null; ownerId: string | null };
type Props = { equipment: { id: string; name: string }; timeZone: string; options: ReservationOptions; labels: Record<string, string> } & (
	| { mode: 'create'; values: Values; requestId: string }
	| { mode: 'edit'; reservation: Reservation });

type Phase =
	| { state: 'editing'; message?: { tone: 'error' | 'done'; text: string } }
	| { state: 'saving' }
	| { state: 'uncertain'; text: string; checking?: boolean }
	| { state: 'exists' }
	| { state: 'reload'; text: string };

const detail = (equipmentId: string, id: string) => `/resources/equipment/${equipmentId}/reservations/${id}`;

/** One local time in the organisation's zone, with the offset it resolves to. A repeated hour asks
 *  which occurrence; a skipped hour says so. The server resolves again with the same zone. */
function LocalTime({ which, label, value, onChange, timeZone, original, disabled }: { which: 'starts' | 'ends'; label: string; value: string; onChange: (v: string) => void;
	timeZone: string; original: string | null; disabled: boolean }) {
	const choices = useMemo(() => { try { return value ? localChoices(value, timeZone) : null; } catch { return null; } }, [value, timeZone]);
	return (
		<div className="field reservation-form__time">
			<label htmlFor={`reservation-${which}`}>{label}</label>
			<input id={`reservation-${which}`} name={`${which}Local`} type="datetime-local" step="0.001" required value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} />
			{choices === null ? null : choices.length === 0 ? (
				<p className="form__error" role="alert">This time does not exist in {timeZone}: the clocks change then. Choose a time before or after the change.</p>
			) : choices.length === 1 ? (
				<p className="muted">UTC{choices[0]!.offset} · {timeZone}</p>
			) : (
				<fieldset className="reservation-form__choice">
					<legend>This time happens twice in {timeZone}. Which one?</legend>
					{choices.map((choice, index) => (
						<label key={choice.instant}><input type="radio" name={`${which}Choice`} value={choice.instant} required defaultChecked={choice.instant === original} disabled={disabled} />
							{index === 0 ? 'First' : 'Second'} (UTC{choice.offset})</label>
					))}
				</fieldset>
			)}
		</div>
	);
}

/** Create or edit one reservation. Nothing shows as booked until the API confirms it; the saved
 *  record page is then the authority. An uncertain outcome locks the form until checked. */
export function ReservationForm(props: Props) {
	const router = useRouter();
	const [pending, start] = useTransition();
	const editing = props.mode === 'edit' ? props.reservation : null;
	// One request id for this form, made on the server with the page and kept through retries, so a
	// repeated send cannot book twice. (Generating it here would differ between server and browser.)
	const [requestId] = useState(props.mode === 'create' ? props.requestId : '');
	const initial: Values = editing ? {
		title: editing.title, kind: editing.kind, startsLocal: localValue(editing.startsAt, props.timeZone), endsLocal: localValue(editing.endsAt, props.timeZone),
		setupMinutes: editing.setupMinutes, cleanupMinutes: editing.cleanupMinutes, projectId: editing.projectId, taskId: editing.taskId, ownerId: editing.ownerId
	} : (props as Extract<Props, { mode: 'create' }>).values;
	const [startsLocal, setStarts] = useState(initial.startsLocal);
	const [endsLocal, setEnds] = useState(initial.endsLocal);
	const [projectId, setProject] = useState(initial.projectId ?? '');
	const [phase, setPhase] = useState<Phase>({ state: 'editing' });
	const locked = pending || phase.state !== 'editing';
	const { people, projects, tasks } = props.options;
	const label = (id: string | null) => (id && props.labels[id]) || 'the current choice';

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault(); if (locked) return;
		const data = new FormData(event.currentTarget);
		setPhase({ state: 'saving' });
		start(async () => {
			let result: Outcome<Reservation>;
			try { result = await (editing ? replaceReservation(data) : createReservation(data)); }
			catch { result = { ok: false, kind: 'uncertain', error: '' }; }
			if (result.ok) { router.push(detail(props.equipment.id, result.value.id)); router.refresh(); return; }
			if (result.kind === 'uncertain') setPhase({ state: 'uncertain', text: editing
				? 'Captain could not confirm whether your changes were saved. Reload this reservation to see what it holds now.'
				: 'Captain could not confirm whether this reservation was saved. Check before doing anything else.' });
			else if (result.kind === 'exists') setPhase({ state: 'exists' });
			else if (result.kind === 'stale') setPhase({ state: 'reload', text: result.error });
			else setPhase({ state: 'editing', message: { tone: 'error', text: result.error } });
		});
	}

	function check() {
		if (phase.state !== 'uncertain' || editing) return;
		setPhase({ ...phase, checking: true });
		start(async () => {
			const found = await checkReservation(props.equipment.id, requestId).catch(() => ({ state: 'unavailable' as const }));
			if (found.state === 'found') { router.push(detail(props.equipment.id, requestId)); router.refresh(); return; }
			if (found.state === 'missing') setPhase({ state: 'editing', message: { tone: 'done', text: 'It was not saved. You can send the same request again; it cannot be booked twice.' } });
			else setPhase({ state: 'uncertain', text: 'Captain still cannot tell whether it was saved. Try checking again in a moment.' });
		});
	}

	const peopleField = people ? (
		<div className="field"><label htmlFor="reservation-owner">Accountable person</label>
			<select id="reservation-owner" name="ownerId" defaultValue={initial.ownerId ?? ''} disabled={locked}>
				<option value="">No one</option>
				{initial.ownerId && !people.some((p) => p.id === initial.ownerId) ? <option value={initial.ownerId}>{label(initial.ownerId)} (no longer a member)</option> : null}
				{people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
			</select></div>
	) : (
		<div className="field"><span className="field__label">Accountable person</span>
			<input type="hidden" name="ownerId" value={initial.ownerId ?? ''} />
			<p className="muted">People could not be read, so {initial.ownerId ? label(initial.ownerId) : 'no one'} stays as the accountable person.</p></div>
	);
	const projectTasks = tasks?.filter((t) => t.projectId === projectId) ?? [];
	const workFields = projects && tasks ? (
		<div className="row reservation-form__links">
			<div className="field"><label htmlFor="reservation-project">Project (optional)</label>
				<select id="reservation-project" name="projectId" value={projectId} onChange={(e) => setProject(e.target.value)} disabled={locked}>
					<option value="">No project</option>
					{initial.projectId && !projects.some((p) => p.id === initial.projectId) ? <option value={initial.projectId}>{label(initial.projectId)} (no longer active)</option> : null}
					{projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
				</select></div>
			<div className="field"><label htmlFor="reservation-task">Task (optional)</label>
				<select id="reservation-task" name="taskId" key={projectId} defaultValue={projectId === (initial.projectId ?? '') ? initial.taskId ?? '' : ''} disabled={locked || !projectId}>
					<option value="">{projectId ? 'No task' : 'Choose a project first'}</option>
					{initial.taskId && projectId === initial.projectId && !projectTasks.some((t) => t.id === initial.taskId) ? <option value={initial.taskId}>{label(initial.taskId)} (no longer open)</option> : null}
					{projectTasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
				</select></div>
		</div>
	) : (
		<div className="field"><span className="field__label">Project and task</span>
			<input type="hidden" name="projectId" value={initial.projectId ?? ''} /><input type="hidden" name="taskId" value={initial.taskId ?? ''} />
			<p className="muted">Projects and tasks could not be read, so the links stay as they are{initial.projectId ? ` (${label(initial.projectId)}${initial.taskId ? `, ${label(initial.taskId)}` : ''})` : ' (none)'}.</p></div>
	);

	return (
		<form className="form reservation-form" onSubmit={submit} method="post" aria-busy={pending || undefined}>
			<input type="hidden" name="equipmentId" value={props.equipment.id} />
			{/* The server refuses the save if the organisation's zone is no longer this one. */}
			<input type="hidden" name="timeZone" value={props.timeZone} />
			{editing ? <><input type="hidden" name="reservationId" value={editing.id} /><input type="hidden" name="expectedRevision" value={editing.revision} /></>
				: <input type="hidden" name="id" value={requestId} />}
			<p className="muted">Equipment: <strong>{props.equipment.name}</strong> · times in {props.timeZone}</p>
			<div className="field"><label htmlFor="reservation-title">Title</label>
				<input id="reservation-title" name="title" type="text" required maxLength={200} defaultValue={initial.title} placeholder="Summer lager packaging" disabled={locked} /></div>
			<fieldset className="reservation-form__kind" disabled={locked}>
				<legend>Kind</legend>
				<label><input type="radio" name="kind" value="booking" defaultChecked={initial.kind === 'booking'} /> Booking</label>
				<label><input type="radio" name="kind" value="maintenance" defaultChecked={initial.kind === 'maintenance'} /> Maintenance or cleaning</label>
			</fieldset>
			<div className="row reservation-form__times">
				<LocalTime which="starts" label="Starts" value={startsLocal} onChange={setStarts} timeZone={props.timeZone} original={editing?.startsAt ?? null} disabled={locked} />
				<LocalTime which="ends" label="Ends" value={endsLocal} onChange={setEnds} timeZone={props.timeZone} original={editing?.endsAt ?? null} disabled={locked} />
			</div>
			<div className="row reservation-form__buffers">
				<div className="field"><label htmlFor="reservation-setup">Setup before (minutes)</label>
					<input id="reservation-setup" name="setupMinutes" type="number" min={0} max={10080} step={1} required defaultValue={initial.setupMinutes} disabled={locked} /></div>
				<div className="field"><label htmlFor="reservation-cleanup">Cleanup after (minutes)</label>
					<input id="reservation-cleanup" name="cleanupMinutes" type="number" min={0} max={10080} step={1} required defaultValue={initial.cleanupMinutes} disabled={locked} /></div>
			</div>
			<p className="muted">Setup and cleanup also occupy the equipment. The save checks every other reservation, including maintenance, at that moment.</p>
			{peopleField}
			{workFields}
			{phase.state === 'editing' && phase.message ? <p className={phase.message.tone === 'error' ? 'form__error' : 'muted'} role={phase.message.tone === 'error' ? 'alert' : 'status'}>{phase.message.text}</p> : null}
			{phase.state === 'uncertain' ? (
				<div className="card notice notice--attention" role="alert">
					<p className="secondary">{phase.text}</p>
					{editing ? <a className="button button--secondary" href={detail(props.equipment.id, editing.id)}>Reload this reservation</a>
						: <button type="button" className="button button--secondary" onClick={check} disabled={pending}>{phase.checking ? 'Checking…' : 'Check whether it was saved'}</button>}
				</div>
			) : null}
			{phase.state === 'exists' ? (
				<div className="card notice notice--attention" role="alert">
					<p className="secondary">This reservation request was already used, so nothing new was booked. Open the existing reservation to review it.</p>
					<Link className="button button--secondary" href={detail(props.equipment.id, requestId)}>Open the existing reservation</Link>
				</div>
			) : null}
			{phase.state === 'reload' ? (
				<div className="card notice notice--attention" role="alert">
					<p className="secondary">{phase.text}</p>
					{editing ? <a className="button button--secondary" href={detail(props.equipment.id, editing.id)}>Reload this reservation</a>
						: <button type="button" className="button button--secondary" onClick={() => window.location.reload()}>Reload the form</button>}
				</div>
			) : null}
			<div className="row">
				<button className="button button--primary" type="submit" disabled={locked}>
					{phase.state === 'saving' ? 'Saving…' : editing ? 'Save changes' : phase.state === 'editing' && phase.message?.tone === 'done' ? 'Send the same request again' : 'Reserve'}
				</button>
				<Link className="button button--ghost" href={editing ? detail(props.equipment.id, editing.id) : '/resources/equipment'}>Cancel</Link>
			</div>
		</form>
	);
}
