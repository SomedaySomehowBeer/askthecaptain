import { SaveForm } from './SaveForm.tsx';
import { StockSection } from './Stock.tsx';
import type { Metadata } from 'next';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { api, load, type Commitments, type Project, type Series, type Task } from '../../lib/api.ts';
import { dateIn, describeDue, recurrenceWords, shortDate } from '../../lib/dates.ts';
import { setProjectArchived, setSeriesPaused, setTaskStatus } from './actions.ts';
import { ProjectForm, SeriesForm, TaskForm } from './Forms.tsx';

export const metadata: Metadata = { title: 'Commitments' };

const isOpen = (task: Task) => task.status === 'open' || task.status === 'in_progress';

function TaskLine({ task, today, timezone, showProject }: { task: Task; today: string; timezone: string; showProject?: Project }) {
	const due = describeDue(task.due, today);
	const doneWhen = task.completedAt ? `done ${shortDate(dateIn(task.completedAt, timezone))}` : null;
	return (
		<li className={`task${task.status === 'done' ? ' task--done' : ''}`}>
			<div className="task__body">
				<span className="task__title">{task.title}</span>
				<span className="task__meta">
					{task.status === 'done' ? <span>{doneWhen}</span> : <span className={due.urgency ? `due--${due.urgency}` : undefined}>{due.text}</span>}
					{task.status === 'in_progress' ? <span>in progress</span> : null}
					{task.status === 'suggested' ? <span className="chip">suggested</span> : null}
					{showProject ? <span>{showProject.name}</span> : null}
					{task.ownerName ? <span>{task.ownerName}</span> : null}
					{task.sourceKind === 'series' ? <span>recurring</span> : null}
					{task.evidenceRequired && task.status !== 'done' ? <span>{task.evidence.length > 0 ? 'evidence attached' : 'needs evidence'}</span> : null}
					{task.evidence.length > 0 ? <span>{task.evidence.length === 1 ? '1 attachment' : `${task.evidence.length} attachments`}</span> : null}
				</span>
				{task.body ? <span className="secondary">{task.body}</span> : null}
			</div>
			<span className="task__actions">
				{task.status === 'suggested' ? (<>
					<SaveForm action={setTaskStatus}><input type="hidden" name="id" value={task.id} /><input type="hidden" name="status" value="open" /><button className="button button--secondary button--small" type="submit">Accept</button></SaveForm>
					<SaveForm action={setTaskStatus}><input type="hidden" name="id" value={task.id} /><input type="hidden" name="status" value="cancelled" /><button className="button button--ghost button--small" type="submit">Dismiss</button></SaveForm>
				</>) : task.status === 'done' ? (
					<SaveForm action={setTaskStatus}><input type="hidden" name="id" value={task.id} /><input type="hidden" name="status" value="open" /><button className="button button--ghost button--small" type="submit">Reopen</button></SaveForm>
				) : (
					<SaveForm action={setTaskStatus}><input type="hidden" name="id" value={task.id} /><input type="hidden" name="status" value="done" /><button className="button button--secondary button--small" type="submit" aria-label={`Mark "${task.title}" done`}>Done</button></SaveForm>
				)}
			</span>
		</li>
	);
}

function SeriesLine({ series }: { series: Series }) {
	return (
		<li className="line">
			<span><strong>{series.title}</strong><br /><span className="muted">{recurrenceWords(series.recurrence, series.everyMonths)}{series.pausedAt ? ', paused' : series.nextDue ? `, next due ${shortDate(series.nextDue)}` : ''}{series.evidenceRequired ? ', needs evidence' : ''}</span></span>
			<SaveForm action={setSeriesPaused}><input type="hidden" name="id" value={series.id} /><input type="hidden" name="paused" value={series.pausedAt ? 'false' : 'true'} />
				<button className="button button--ghost button--small" type="submit">{series.pausedAt ? 'Resume' : 'Pause'}</button></SaveForm>
		</li>
	);
}

function ProjectCard({ project, tasks, series, projects, today, timezone }: { project: Project; tasks: Task[]; series: Series[]; projects: Project[]; today: string; timezone: string }) {
	const open = tasks.filter(isOpen); const suggested = tasks.filter((t) => t.status === 'suggested'); const done = tasks.filter((t) => t.status === 'done');
	const deadlineBook = project.systemKind === 'obligations';
	return (
		<section className={`card${project.archivedAt ? ' card--archived' : ''}`} aria-labelledby={`project-${project.id}`}>
			<div className="row row--between">
				<h2 id={`project-${project.id}`}>{project.name}</h2>
				{deadlineBook ? <span className="chip">deadline book</span> : (
					<SaveForm action={setProjectArchived}><input type="hidden" name="id" value={project.id} /><input type="hidden" name="archived" value={project.archivedAt ? 'false' : 'true'} />
						<button className="button button--ghost button--small" type="submit">{project.archivedAt ? 'Restore' : 'Archive'}</button></SaveForm>
				)}
			</div>
			{project.description ? <p className="secondary">{project.description}</p> : null}
			{project.archivedAt ? <p className="muted">Archived {shortDate(dateIn(project.archivedAt, timezone))}. Nothing new can be added until it is restored.</p> : null}
			{suggested.length > 0 ? <ul className="bare">{suggested.map((task) => <TaskLine key={task.id} task={task} today={today} timezone={timezone} />)}</ul> : null}
			{open.length > 0 ? <ul className="bare">{open.map((task) => <TaskLine key={task.id} task={task} today={today} timezone={timezone} />)}</ul>
				: <p className="muted">{deadlineBook ? 'Nothing is due. Add a recurring duty below and its next occurrence appears here.' : 'Nothing open here.'}</p>}
			{deadlineBook || series.length > 0 ? (
				<div className="stack">
					<h3>Recurring duties</h3>
					{series.length > 0 ? <ul className="bare">{series.map((s) => <SeriesLine key={s.id} series={s} />)}</ul> : <p className="muted">None yet. The excise return, the BAS, a licence renewal: anything owed on a date, every period.</p>}
					{project.archivedAt ? null : <details className="disclosure"><summary>Add a recurring duty</summary><SeriesForm projects={projects} projectId={project.id} /></details>}
				</div>
			) : null}
			{project.archivedAt ? null : <details className="disclosure"><summary>Add a task</summary><TaskForm projects={projects} projectId={project.id} compact /></details>}
			{done.length > 0 ? <details className="disclosure"><summary>Done ({done.length})</summary><ul className="bare">{done.map((task) => <TaskLine key={task.id} task={task} today={today} timezone={timezone} />)}</ul></details> : null}
		</section>
	);
}

export default async function CommitmentsPage() {
	// The layout has already sent a signed-out person to sign in; this is the cached session.
	const me = await requireCurrent('/commitments');
	// Read the independent sections together; each keeps its own failed state.
	const [loaded, stock] = await Promise.all([
		load(() => api<Commitments>(`/v1/organisations/${me.organisation.organisationId}/commitments`, { token: me.token })),
		StockSection({ me })
	]);
	if (!loaded.ok) {
		return (
			<Page title="Commitments" lede={me.organisation.organisationName}>
				<Notice tone="failed" title="The list could not be read.">{loaded.error.message}{loaded.error.offline ? ' Try again in a moment.' : ''}</Notice>
				{stock}
			</Page>
		);
	}
	const { projects, tasks, series, today, timezone } = loaded.value;
	const live = projects.filter((p) => !p.archivedAt); const archived = projects.filter((p) => p.archivedAt);
	const attention = tasks.filter((t) => isOpen(t) && t.due && describeDue(t.due, today).urgency !== 'later' && !projects.find((p) => p.id === t.projectId)?.archivedAt);
	const nothingYet = tasks.length === 0 && series.length === 0;
	const byProject = (id: string) => ({ tasks: tasks.filter((t) => t.projectId === id), series: series.filter((s) => s.projectId === id) });
	return (
		<Page title="Commitments" lede={nothingYet ? 'One list of what the business owes: projects, tasks and the duties that come round every period.' : me.organisation.organisationName}>
			{nothingYet ? (
				<Notice title="Nothing is owed yet.">Add a task to any project, or a recurring duty to the deadline book. When mail is connected, triage will add suggested tasks here too.</Notice>
			) : attention.length > 0 ? (
				<section className="card" aria-labelledby="attention">
					<h2 id="attention">Due this week</h2>
					<ul className="bare">{attention.map((task) => <TaskLine key={task.id} task={task} today={today} timezone={timezone} showProject={projects.find((p) => p.id === task.projectId)} />)}</ul>
				</section>
			) : (
				<Notice title="Nothing is due this week.">Everything open has a later date or none. The full list is below.</Notice>
			)}
			<section className="card">
				<h2>Add a task</h2>
				<TaskForm projects={live} compact />
			</section>
			{live.map((project) => <ProjectCard key={project.id} project={project} projects={live} today={today} timezone={timezone} {...byProject(project.id)} />)}
			<section className="card">
				<h2>New project</h2>
				<p className="secondary">A project is a name for a stream of work: Wholesale, Production, the new taproom. Tasks and duties belong to one.</p>
				<ProjectForm />
			</section>
			{archived.length > 0 ? (
				<details className="disclosure"><summary>Archived projects ({archived.length})</summary>
					<div className="stack">{archived.map((project) => <ProjectCard key={project.id} project={project} projects={live} today={today} timezone={timezone} {...byProject(project.id)} />)}</div>
				</details>
			) : null}
			{stock}
		</Page>
	);
}
