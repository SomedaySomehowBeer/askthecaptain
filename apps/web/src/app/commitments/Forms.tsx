'use client';
import { useState } from 'react';
import { useSaveForm } from './SaveForm.tsx';
import type { Project } from '../../lib/api.ts';
import { createProject, createSeries, createStep, createTask, saveBrief, type Result } from './actions.ts';

const Feedback = ({ state }: { state: Result | undefined }) => state?.error ? <p className="form__error" role="alert">{state.error}</p> : null;
const ProjectSelect = ({ id, projects, defaultValue }: { id: string; projects: Project[]; defaultValue?: string }) => (
	<div className="field"><label htmlFor={id}>Project</label>
		<select id={id} name="projectId" defaultValue={defaultValue ?? projects.find((p) => p.systemKind)?.id}>{projects.filter((p) => !p.archivedAt).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
);

/** A task in words: what, where, by when. Everything else is edited later. */
export function TaskForm({ projects, projectId, compact }: { projects: Project[]; projectId?: string; compact?: boolean }) {
	const [state, action, pending] = useSaveForm((form) => createTask(undefined, form));
	const id = `task-${projectId ?? 'any'}`;
	return (
		<form className="form" onSubmit={action} method="post">
			<div className="row">
				<div className="field" style={{ flex: '1 1 220px' }}><label htmlFor={`${id}-title`}>Task</label><input id={`${id}-title`} name="title" type="text" required maxLength={200} placeholder="Send updated price list" /></div>
				{projectId ? <input type="hidden" name="projectId" value={projectId} /> : <ProjectSelect id={`${id}-project`} projects={projects} />}
				<div className="field"><label htmlFor={`${id}-due`}>Due</label><input id={`${id}-due`} name="due" type="date" /></div>
			</div>
			{compact ? null : <div className="field"><label htmlFor={`${id}-body`}>Notes</label><textarea id={`${id}-body`} name="body" maxLength={5000} /></div>}
			<Feedback state={state} />
			<div className="row"><button className="button button--primary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Adding…' : 'Add task'}</button></div>
		</form>
	);
}

export function ProjectForm() {
	const [state, action, pending] = useSaveForm((form) => createProject(undefined, form));
	return (
		<form className="form" onSubmit={action} method="post">
			<div className="row">
				<div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="project-name">Name</label><input id="project-name" name="name" type="text" required maxLength={120} placeholder="Wholesale" /></div>
				<div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="project-stages">Stages, comma-separated (optional)</label><input id="project-stages" name="stages" type="text" maxLength={400} placeholder="Planned, Brewing, Packaged" /></div>
			</div>
			<div className="field"><label htmlFor="project-description">What it is for</label><textarea id="project-description" name="description" maxLength={2000} /></div>
			<Feedback state={state} />
			<div className="row"><button className="button button--secondary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Creating…' : 'Create project'}</button></div>
		</form>
	);
}

/** A recurring duty: the rule that makes a task for every period. */
export function SeriesForm({ projects, projectId }: { projects: Project[]; projectId?: string }) {
	const [state, action, pending] = useSaveForm((form) => createSeries(undefined, form));
	const [recurrence, setRecurrence] = useState('monthly');
	return (
		<form className="form" onSubmit={action} method="post">
			<div className="row">
				<div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="series-title">Duty</label><input id="series-title" name="title" type="text" required maxLength={200} placeholder="Excise return" /></div>
				{projectId ? <input type="hidden" name="projectId" value={projectId} /> : <ProjectSelect id="series-project" projects={projects} />}
			</div>
			<div className="row">
				<div className="field"><label htmlFor="series-recurrence">Repeats</label>
					<select id="series-recurrence" name="recurrence" value={recurrence} onChange={(event) => setRecurrence(event.target.value)}>
						<option value="monthly">monthly</option><option value="quarterly">quarterly</option><option value="yearly">yearly</option><option value="weekdays">every weekday</option><option value="custom">every N months</option>
					</select></div>
				{recurrence === 'custom' ? <div className="field"><label htmlFor="series-every">N</label><input id="series-every" name="everyMonths" type="number" min={1} max={120} defaultValue={2} style={{ width: '5em' }} /></div> : null}
				<div className="field"><label htmlFor="series-anchor">First period starts</label><input id="series-anchor" name="anchor" type="date" required /></div>
				{recurrence === 'weekdays' ? null : <div className="field"><label htmlFor="series-offset">Due, days after the period ends</label><input id="series-offset" name="dueOffsetDays" type="number" min={-366} max={366} defaultValue={0} style={{ width: '6em' }} /></div>}
			</div>
			<label className="row" style={{ fontSize: 13 }}><input type="checkbox" name="evidenceRequired" /> Needs evidence attached before it counts as done</label>
			<p className="muted">Write <span className="mono">{'{period}'}</span> in the duty name to place the period; otherwise it is added at the end.</p>
			<Feedback state={state} />
			<div className="row"><button className="button button--secondary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Adding…' : 'Add recurring duty'}</button></div>
		</form>
	);
}

/** A step under an open task: one line, added to its checklist. */
export function StepForm({ taskId }: { taskId: string }) {
	const [state, action, pending] = useSaveForm(createStep);
	const id = `step-${taskId}`;
	return (
		<form className="form" onSubmit={action} method="post"><input type="hidden" name="parentId" value={taskId} />
			<div className="row">
				<div className="field" style={{ flex: '1 1 220px' }}><label htmlFor={id}>Step</label><input id={id} name="title" type="text" required maxLength={200} placeholder="Export the print-ready PDF" /></div>
				<button className="button button--secondary button--small" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Adding…' : 'Add step'}</button>
			</div>
			<Feedback state={state} />
		</form>
	);
}

const briefFields: [keyof Project['brief'], string][] = [['what', 'What this is'], ['standing', 'Where it stands'], ['people', 'Who is involved'], ['questions', 'Open questions']];
/** The brief in four lists, one line per row, and the project's stage. */
export function BriefForm({ project }: { project: Project }) {
	const [state, action, pending] = useSaveForm(saveBrief);
	const id = `brief-${project.id}`;
	return (
		<form className="form" onSubmit={action} method="post"><input type="hidden" name="id" value={project.id} /><input type="hidden" name="existing" value={JSON.stringify(project.brief)} />
			<div className="field"><label htmlFor={`${id}-stage`}>Stage</label>
				<select id={`${id}-stage`} name="stage" defaultValue={project.stage}><option value="idea">Idea: being considered</option><option value="underway">Underway: work has begun</option></select></div>
			{briefFields.map(([key, label]) => <div className="field" key={key}><label htmlFor={`${id}-${key}`}>{label}, one line each</label>
				<textarea id={`${id}-${key}`} name={key} rows={3} maxLength={15000} defaultValue={project.brief[key].map((line) => line.text).join('\n')} /></div>)}
			<p className="muted">A line written by discovery keeps its link to the mail or note it came from while its text is unchanged.</p>
			<Feedback state={state} />
			<div className="row"><button className="button button--primary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Saving…' : 'Save brief'}</button></div>
		</form>
	);
}
