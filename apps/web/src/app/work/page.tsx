import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { api, load, type Organisation, type Member, type Project } from '../../lib/api.ts';
import { dateIn, describeDue, shortDate } from '../../lib/dates.ts';
import { apiQuery, isDefault, maxTags, nextHref, pageSize, parseFilters, projectLabel, statuses, statusWords, unlistedTags, workHref, type Search, type WorkFilters } from './filters.ts';
import { type TagPage, type WorkPage as WorkTasks, type WorkTask } from './types.ts';
import { TaskListFeedback } from './TaskListFeedback.tsx';
import { TaskCheckRow } from './ChecklistItem.tsx';
import { groupWork } from './group-work.ts';
import { WorkSwitch } from './WorkSwitch.tsx';
import './work.css';

export const metadata: Metadata = { title: 'Work' };

function titleFor(filters: WorkFilters) {
	if (isDefault(filters)) return 'My work';
	return filters.owner === 'me' ? 'Assigned to you' : 'All tasks';
}

function TaskRow({ task, today, meId, owners, projects, returnHref }: { returnHref: string; task: WorkTask; today: string | null; meId: string; owners: Map<string, string>; projects: Map<string, Project> }) {
	const due = today ? describeDue(task.due, today) : { text: task.due ? `due ${task.due}` : 'no date', urgency: null };
	const project = task.projectId ? projects.get(task.projectId) : undefined;
	const owner = task.ownerId === meId ? 'You' : task.ownerId ? owners.get(task.ownerId) ?? 'Another member' : 'No owner';
	const active = task.status !== 'done' && task.status !== 'cancelled';
	const content = (<>
        <span className="work-task__heading"><span className="work-task__title">{task.title}</span>{task.due ? <time className={`work-task__due${active && due.urgency ? ` due--${due.urgency}` : ''}`} dateTime={task.due} title={due.text}>{!active ? shortDate(task.due) : due.urgency === 'overdue' ? 'Overdue' : due.text.replace(/^due /, '')}</time> : null}</span>
        <span className="work-task__meta">
            {task.tags.map(tag => <span key={tag.id} className="chip">{tag.name}</span>)}
            <span>{project ? project.name : task.projectId ? 'In a project' : 'No project'}</span>
            <span>{owner}</span>
            {task.status !== 'open' ? <span>{statusWords[task.status as keyof typeof statusWords] ?? task.status}</span> : null}
        </span>
    </>);
	return <TaskCheckRow task={task} parentHref={returnHref} variant="task">{content}</TaskCheckRow>;
}

export default async function WorkPage({ searchParams }: { searchParams: Promise<Search> }) {
	const me = await requireCurrent('/work');
	const parsed = parseFilters(await searchParams);
	if (!parsed.ok) {
		return (
			<Page title="Work">
				<Notice title="These filters could not be read" tone="attention" action={{ href: '/work', label: 'Show my work' }}>
					{parsed.problems.join(' ')}
				</Notice>
			</Page>
		);
	}
	const filters = parsed.filters;
	const org = me.organisation.organisationId; const token = me.token; const meId = me.me.user.id;
	const [tasks, tags, overview, members, organisation, chosenProject] = await Promise.all([
		load(() => api<WorkTasks>(`/v1/organisations/${org}/tasks?${apiQuery(filters, meId)}`, { token })),
		load(() => api<TagPage>(`/v1/organisations/${org}/tags?limit=100`, { token })),
		load(() => api<{projects:Project[];nextOffset:number|null}>(`/v1/organisations/${org}/projects?limit=50`, { token })),
		load(() => api<{ members: Member[] }>(`/v1/organisations/${org}/members`, { token })),
		load(()=>api<Organisation>(`/v1/organisations/${org}`,{token})),
		filters.projectId?load(()=>api<Project>(`/v1/organisations/${org}/projects/${filters.projectId}`,{token})):null
	]);
	const projects = new Map((overview.ok ? overview.value.projects : []).map((p) => [p.id, p]));
	if(chosenProject?.ok) projects.set(chosenProject.value.id,chosenProject.value);
	const activeProjects = [...projects.values()].filter((p) => p.state === 'active');
	const owners = new Map((members.ok ? members.value.members : []).map((m) => [m.userId, m.name || m.email]));
	const tagNames = new Map((tags.ok ? tags.value.tags : []).map((t) => [t.id, t.name]));
	const unlisted = unlistedTags(filters.tagIds, tags.ok ? tags.value.tags : null);
	const selectedProject = filters.projectId ? projects.get(filters.projectId) : undefined;
	const projectOffered = !!selectedProject && selectedProject.state === 'active';
	const tagName = (id: string) => tagNames.get(id) ?? (tags.ok ? 'Tag not in the list' : 'Selected tag');
	const next = tasks.ok ? nextHref(filters, tasks.value.nextOffset) : null;
	const today = organisation.ok ? dateIn(new Date().toISOString(), organisation.value.timezone) : null;
	const groups = tasks.ok ? groupWork(tasks.value.tasks, today) : [];
	const returnHref = workHref(filters, { offset: filters.offset });
	const newTaskHref = filters.projectId ? `/work/new?projectId=${filters.projectId}` : '/work/new';

	return (
		<Page title={titleFor(filters)} lede={filters.owner === 'me' ? 'Your assigned work across the business.' : 'Shared work across the business.'}>
            <WorkSwitch selected="tasks"/>
			<section className="card work-filters" aria-label="Filters">
				<div className="work-filters__active">
					<span className="chip">{filters.owner === 'me' ? 'Assigned to you' : 'Everyone'}</span>
					<span className="chip">{statusWords[filters.status]}</span>
					{filters.projectId ? (
						<span className="chip chip--project work-chip">{overview.ok ? projectLabel(selectedProject) : 'Selected project'}
							<Link className="work-chip__remove" href={workHref(filters, { projectId: null })} aria-label="Remove the project filter">×</Link></span>
					) : null}
					{filters.tagIds.map((id) => (
						<span key={id} className="chip work-chip">{tagName(id)}
							<Link className="work-chip__remove" href={workHref(filters, { tagIds: filters.tagIds.filter((t) => t !== id) })} aria-label={`Remove the tag filter ${tagName(id)}`}>×</Link></span>
					))}
					{!isDefault(filters) ? <Link className="work-filters__clear" href="/work">Back to my work</Link> : null}
				</div>
				<details className="disclosure">
					<summary>Filter</summary>
					<form className="form work-filters__form" method="get" action="/work">
						<div className="row">
							<div className="field"><label htmlFor="work-owner">Owner</label>
								<select id="work-owner" name="owner" defaultValue={filters.owner}><option value="me">Assigned to you</option><option value="all">Everyone</option></select></div>
							<div className="field"><label htmlFor="work-status">Status</label>
								<select id="work-status" name="status" defaultValue={filters.status}>{statuses.map((s) => <option key={s} value={s}>{statusWords[s]}</option>)}</select></div>
							{overview.ok ? (
								<div className="field"><label htmlFor="work-project">Project</label>
									<select id="work-project" name="projectId" defaultValue={filters.projectId ?? ''}>
										<option value="">Any project</option>
										{filters.projectId && !projectOffered ? <option value={filters.projectId}>{projectLabel(selectedProject)}</option> : null}
										{activeProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
									</select>{overview.value.nextOffset!==null?<p className="muted">The first 50 projects are shown. <Link href="/work/projects">Browse all projects</Link> to open one and see its tasks.</p>:null}</div>
							) : filters.projectId ? <input type="hidden" name="projectId" value={filters.projectId} /> : null}
						</div>
						{(tags.ok && tags.value.tags.length) || unlisted.length ? (
							<fieldset className="work-filters__tags">
								<legend>Tags <span className="muted">(any of them; at most {maxTags})</span></legend>
								{unlisted.map((id) => (
									<label key={id} className="work-tag-option"><input type="checkbox" name="tagId" value={id} defaultChecked />{tagName(id)}</label>
								))}
								{(tags.ok ? tags.value.tags : []).map((tag) => (
									<label key={tag.id} className="work-tag-option"><input type="checkbox" name="tagId" value={tag.id} defaultChecked={filters.tagIds.includes(tag.id)} />{tag.name}</label>
								))}
								{tags.ok && tags.value.nextOffset !== null ? <p className="muted">Only the first 100 tags are listed; a selected tag beyond them stays selected.</p> : null}
							</fieldset>
						) : null}
						{!tags.ok ? <p className="muted">Tags could not be read: {tags.error.message}. Tags already selected stay selected.</p> : tags.value.tags.length === 0 && !unlisted.length ? <p className="muted">No tags yet.</p> : null}
						<div className="row"><button className="button button--secondary" type="submit">Apply</button></div>
					</form>
				</details>
				{!overview.ok ? <p className="muted">Project names could not be read: {overview.error.message}</p> : null}
			</section>

            <TaskListFeedback>
			{!tasks.ok ? (
				<Notice title="Work could not be read" tone="failed" action={{ href: workHref(filters, { offset: filters.offset }), label: 'Try again' }}>
					{tasks.error.message}{tasks.error.requestId ? ` Reference: ${tasks.error.requestId}` : ''}
				</Notice>
			) : tasks.value.tasks.length === 0 ? (
				filters.offset > 0 ? (
					<Notice title="Nothing on this page" action={{ href: workHref(filters), label: 'Back to the first page' }}>The list is shorter than this page.</Notice>
				) : isDefault(filters) ? (
					<Notice title="Nothing open is assigned to you" action={{ href: workHref(filters, { owner: 'all' }), label: 'See all tasks' }}>
						Tasks you own appear here while they are open.
					</Notice>
				) : (
					<Notice title="No tasks match these filters" action={{ href: '/work', label: 'Back to my work' }}>
						{selectedProject && selectedProject.state !== 'active'
							? `${projectLabel(selectedProject)} has no tasks matching these filters.`
							: 'Change a filter, or clear them to see your open work.'}
					</Notice>
				)
			) : (
				<section className="work-groups" aria-label="Tasks">
                    {!organisation.ok ? <p className="muted">The business date could not be read. Showing recorded due dates.</p> : null}
                    {filters.offset > 0 || next ? <p className="muted">Groups show the tasks on this page.</p> : null}
                    {groups.map(group => <section className="work-due-group" key={group.label}><h2>{group.label}</h2><ul className="bare work-list work-list--card" aria-label={group.label}>{group.tasks.map(task => <TaskRow key={`${task.id}-${task.revision}`} task={task} today={today} meId={meId} owners={owners} projects={projects} returnHref={returnHref}/>)}</ul></section>)}
					{filters.offset > 0 || next ? (
						<nav className="row row--between" aria-label="Pages">
							{filters.offset > 0 ? <Link className="button button--ghost" href={workHref(filters, { offset: Math.max(0, filters.offset - pageSize) })}>Previous</Link> : <span />}
							{next ? <Link className="button button--ghost" href={next}>Next</Link> : null}
						</nav>
					) : null}
				</section>
			)}

            </TaskListFeedback>
			<Link className="work-plus" href={newTaskHref} aria-label="New task">
				<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
			</Link>
		</Page>
	);
}
