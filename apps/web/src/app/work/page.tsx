import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { api, load, type Commitments, type Member, type Project } from '../../lib/api.ts';
import { describeDue } from '../../lib/dates.ts';
import { apiQuery, isDefault, maxTags, nextHref, pageSize, parseFilters, projectLabel, statuses, statusWords, unlistedTags, workHref, type Search, type WorkFilters } from './filters.ts';
import { workTaskHref, type TagPage, type WorkPage as WorkTasks, type WorkTask } from './types.ts';
import './work.css';

export const metadata: Metadata = { title: 'Work' };

function titleFor(filters: WorkFilters) {
	if (isDefault(filters)) return 'My work';
	return filters.owner === 'me' ? 'Assigned to you' : 'All tasks';
}

function TaskRow({ task, today, meId, owners, projects }: { task: WorkTask; today: string | null; meId: string; owners: Map<string, string>; projects: Map<string, Project> }) {
	const due = today ? describeDue(task.due, today) : { text: task.due ? `due ${task.due}` : 'no date', urgency: null };
	const project = projects.get(task.projectId);
	const owner = task.ownerId === meId ? 'You' : task.ownerId ? owners.get(task.ownerId) ?? 'Another member' : 'No owner';
	const href = workTaskHref(task);
	const content = (<>
				<span className="work-task__title">{task.title}</span>
				<span className="work-task__meta">
					<span className={due.urgency ? `due--${due.urgency}` : undefined}>{task.status === 'done' ? 'done' : due.text}</span>
					{task.status !== 'open' && task.status !== 'done' ? <span>{statusWords[task.status as keyof typeof statusWords] ?? task.status}</span> : null}
					<span>{owner}</span>
					{project ? <span>{project.systemKind === 'obligations' ? 'Obligations' : project.name}</span> : null}
				</span>
				{task.tags.length ? <span className="work-task__tags">{task.tags.map((tag) => <span key={tag.id} className="chip">{tag.name}</span>)}</span> : null}
				{href ? null : <span className="muted">Cancelled tasks are not listed on Commitments, so this one has no page to open.</span>}
	</>);
	return (
		<li className="work-task">
			{href ? <Link className="work-task__link" href={href}>{content}</Link> : <div className="work-task__link">{content}</div>}
			<Link className="work-task__edit-tags" href={`/work/tasks/${task.id}/tags`} aria-label={`Edit tags for ${task.title}`}>Edit tags</Link>
		</li>
	);
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
	const [tasks, tags, overview, members] = await Promise.all([
		load(() => api<WorkTasks>(`/v1/organisations/${org}/tasks?${apiQuery(filters, meId)}`, { token })),
		load(() => api<TagPage>(`/v1/organisations/${org}/tags?limit=100`, { token })),
		load(() => api<Commitments>(`/v1/organisations/${org}/commitments`, { token })),
		load(() => api<{ members: Member[] }>(`/v1/organisations/${org}/members`, { token }))
	]);
	const projects = new Map((overview.ok ? overview.value.projects : []).map((p) => [p.id, p]));
	const activeProjects = [...projects.values()].filter((p) => p.state === 'active');
	const owners = new Map((members.ok ? members.value.members : []).map((m) => [m.userId, m.name || m.email]));
	const tagNames = new Map((tags.ok ? tags.value.tags : []).map((t) => [t.id, t.name]));
	const unlisted = unlistedTags(filters.tagIds, tags.ok ? tags.value.tags : null);
	const selectedProject = filters.projectId ? projects.get(filters.projectId) : undefined;
	const projectOffered = !!selectedProject && selectedProject.state === 'active';
	const tagName = (id: string) => tagNames.get(id) ?? (tags.ok ? 'Tag not in the list' : 'Selected tag');
	const next = tasks.ok ? nextHref(filters, tasks.value.nextOffset) : null;
	const newTaskHref = filters.projectId ? `/work/new?projectId=${filters.projectId}` : '/work/new';

	return (
		<Page title={titleFor(filters)}>
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
										{activeProjects.map((p) => <option key={p.id} value={p.id}>{p.systemKind === 'obligations' ? 'Obligations' : p.name}</option>)}
									</select></div>
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
							? `${projectLabel(selectedProject)}: Work lists tasks in active projects only. Open it on Commitments, or remove the project filter.`
							: 'Change a filter, or clear them to see your open work.'}
					</Notice>
				)
			) : (
				<section className="card">
					<ul className="bare work-list" aria-label="Tasks">
						{tasks.value.tasks.map((task) => <TaskRow key={task.id} task={task} today={overview.ok ? overview.value.today : null} meId={meId} owners={owners} projects={projects} />)}
					</ul>
					{filters.offset > 0 || next ? (
						<nav className="row row--between" aria-label="Pages">
							{filters.offset > 0 ? <Link className="button button--ghost" href={workHref(filters, { offset: Math.max(0, filters.offset - pageSize) })}>Previous</Link> : <span />}
							{next ? <Link className="button button--ghost" href={next}>Next</Link> : null}
						</nav>
					) : null}
				</section>
			)}

			<Link className="work-plus" href={newTaskHref} aria-label="New task">
				<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
			</Link>
		</Page>
	);
}
