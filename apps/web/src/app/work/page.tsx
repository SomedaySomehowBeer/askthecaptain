import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { api, load, type Organisation, type Member, type Project } from '../../lib/api.ts';
import { dateIn, describeDue, shortDate } from '../../lib/dates.ts';
import { apiQuery, isDefault, maxTags, nextHref, pageSize, parseFilters, projectLabel, statuses, statusWords, unlistedTags, workHref, type Search, type WorkFilters } from './filters.ts';
import { describeFilter, draftChange, draftHref, filtersFor, parseWorkUrl, readView, referenceLabels, referenceNotes, sameFilter, savedFilterOf, savedHref, scopeKey, type Labels, type SavedFilter, type SavedView, type ViewReferences } from './saved-views.ts';
import { type TagPage, type WorkPage as WorkTasks, type WorkTask } from './types.ts';
import { TaskListFeedback } from './TaskListFeedback.tsx';
import { TaskCheckRow } from './ChecklistItem.tsx';
import { groupWork } from './group-work.ts';
import { WorkSwitch } from './WorkSwitch.tsx';
import { SaveViewForm } from './SaveViewForm.tsx';
import { DraftBar } from './DraftBar.tsx';
import { ManageView } from './ManageView.tsx';
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
        <span className="work-task__heading"><span className="work-task__title">{task.title}</span>{task.due ? <time className={`work-task__due${active && due.urgency ? ` due--${due.urgency}` : ''}`} dateTime={task.due} title={`Due ${task.due}`}>{!active ? shortDate(task.due) : due.urgency === 'overdue' ? 'Overdue' : due.text.replace(/^due /, '')}</time> : null}</span>
        <span className="work-task__meta">
            {task.tags.map(tag => <span key={tag.id} className="chip">{tag.name}</span>)}
            <span>{project ? project.name : task.projectId ? 'In a project' : 'No project'}</span>
            <span>{owner}</span>
            {task.status !== 'open' ? <span>{statusWords[task.status as keyof typeof statusWords] ?? task.status}</span> : null}
        </span>
    </>);
	return <TaskCheckRow task={task} parentHref={returnHref} variant="task">{content}</TaskCheckRow>;
}

/** Which list this URL shows. A saved view and its draft keep their identity in every link the page
 *  writes (filter chips, the filter form, paging), so nothing quietly drops back to plain filters. */
type Mode =
	| { kind: 'plain' }
	| { kind: 'saved'; view: SavedView; stored: SavedFilter }
	| { kind: 'draft'; view: SavedView; stored: SavedFilter; base: number };

const myWork = { href: '/work', label: 'Show my work' };

/** The references that still apply to the filter on screen; a draft may have removed some. */
function applying(references: ViewReferences | null | undefined, filter: SavedFilter): ViewReferences | undefined {
	if (!references) return undefined;
	return { tags: references.tags.filter((ref) => filter.tagIds.includes(ref.id.toLowerCase())), project: references.project && references.project.id.toLowerCase() === filter.projectId ? references.project : null };
}

export default async function WorkPage({ searchParams }: { searchParams: Promise<Search> }) {
	const me = await requireCurrent('/work');
	const search = await searchParams;
	const url = parseWorkUrl(search);
	if (url.mode === 'edit') redirect(url.href);
	if (url.mode === 'invalid') {
		return (
			<Page title="Work">
				<Notice title="This link could not be read" tone="attention" action={url.viewId ? { href: savedHref(url.viewId), label: 'Open the saved view unchanged' } : myWork}>
					{url.problems.join(' ')}
				</Notice>
				{url.viewId ? <p><Link href="/work">Show my work</Link></p> : null}
			</Page>
		);
	}
	if (url.mode === 'inconsistent') {
		return (
			<Page title="Work">
				<Notice title="This saved view link is inconsistent" tone="attention" action={{ href: savedHref(url.viewId), label: 'Open the saved view unchanged' }}>
					It names a saved view and also sets filters of its own. A saved view link applies only the view&rsquo;s saved filter, so nothing has been shown rather than guessing which you meant.
				</Notice>
				<p><Link href="/work">Show my work</Link></p>
			</Page>
		);
	}

	const org = me.organisation.organisationId; const token = me.token; const meId = me.me.user.id;
	// Scopes this tab's unconfirmed-create record (never a token): the signed-in person in this organisation.
	const scope = { userId: meId, organisationId: org };
	// Client state (pending saves, drafts, rename/delete) never carries across people or organisations.
	const stateKey = scopeKey(scope);
	let mode: Mode = { kind: 'plain' };
	let filters: WorkFilters;
	if (url.mode === 'plain') {
		const parsed = parseFilters(search);
		if (!parsed.ok) {
			return (
				<Page title="Work">
					<Notice title="These filters could not be read" tone="attention" action={myWork}>
						{parsed.problems.join(' ')}
					</Notice>
				</Page>
			);
		}
		filters = parsed.filters;
	} else {
		// A saved view is always read afresh, including its current revision. Nothing falls back to My work.
		const read = await load(() => api<SavedView>(`/v1/organisations/${org}/views/${url.viewId}`, { token }));
		const withoutView = url.mode === 'draft' ? workHref(filtersFor(url.filter)) : null;
		if (!read.ok) {
			// The API refused the id itself (its check is the authority): the same state as a malformed link.
			if (read.error.status === 400) {
				return (
					<Page title="Work">
						<Notice title="This link could not be read" tone="attention" action={myWork}>That saved view reference is not valid.</Notice>
					</Page>
				);
			}
			if (read.error.status === 404) {
				return (
					<Page title="Work">
						<Notice title="This saved view is not available" tone="attention" action={myWork}>
							It may have been deleted, or it is not one of your saved views. Saved views are private to the person who saved them.
						</Notice>
						{withoutView ? <p><Link href={withoutView}>Open these filters without the view</Link></p> : null}
					</Page>
				);
			}
			return (
				<Page title="Work">
					<Notice title="This saved view could not be read" tone="failed" action={{ href: url.mode === 'draft' ? draftHref(url.viewId, url.base, url.filter, url.offset) : savedHref(url.viewId, url.offset), label: 'Try again' }}>
						{read.error.message}{read.error.requestId ? ` Reference: ${read.error.requestId}` : ''} Nothing else has been shown in its place.
					</Notice>
					<p><Link href="/work">Show my work</Link></p>
				</Page>
			);
		}
		const reading = readView(read.value);
		if (!reading.ok) {
			return (
				<Page title="Work">
					<Notice title={reading.state === 'newer' ? `“${read.value.name}” needs a newer version of Captain` : `“${read.value.name}” could not be read`} tone="attention" action={myWork}>
						{reading.reason} Its filter has not been applied, and nothing else has been shown in its place.
					</Notice>
				</Page>
			);
		}
		if (url.mode === 'saved') { mode = { kind: 'saved', view: read.value, stored: reading.filter }; filters = filtersFor(reading.filter, url.offset); }
		else { mode = { kind: 'draft', view: read.value, stored: reading.filter, base: url.base }; filters = filtersFor(url.filter, url.offset); }
	}

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
	const view = mode.kind === 'plain' ? null : mode.view;
	const listed = { tags: tagNames, projects: new Map([...projects.values()].map((p) => [p.id, projectLabel(p)])) };
	const labels: Labels = view ? referenceLabels(view.references, listed) : {
		tag: (id) => tagNames.get(id) ?? (tags.ok ? 'Tag not in the list' : 'Selected tag'),
		project: () => overview.ok ? projectLabel(selectedProject) : 'Selected project'
	};
	const tagName = labels.tag;
	const current = savedFilterOf(filters);
	const words = describeFilter(current, labels);
	const notes = view ? referenceNotes(applying(view.references, current)) : [];

	/** Every link that changes the list: a filter change starts (or continues) a draft with a fixed
	 *  base; paging alone keeps an unmodified view unmodified. */
	const hrefFor = (change: Partial<WorkFilters> = {}): string => {
		if (mode.kind === 'plain') return workHref(filters, change);
		const { offset = 0, ...rest } = change;
		if (mode.kind === 'saved' && Object.keys(rest).length === 0) return savedHref(mode.view.id, offset);
		const base = mode.kind === 'saved' ? mode.view.revision : mode.base;
		return draftChange(mode.view.id, base, current, { ...rest, offset });
	};
	const next = tasks.ok ? nextHref(filters, tasks.value.nextOffset) && hrefFor({ offset: tasks.value.nextOffset! }) : null;
	const today = organisation.ok ? dateIn(new Date().toISOString(), organisation.value.timezone) : null;
	const groups = tasks.ok ? groupWork(tasks.value.tasks, today) : [];
	const returnHref = hrefFor({ offset: filters.offset });
	const newTaskHref = filters.projectId ? `/work/new?projectId=${filters.projectId}` : '/work/new';
	const title = view ? view.name : titleFor(filters);
	const lede = view ? words : filters.owner === 'me' ? 'Your assigned work across the business.' : 'Shared work across the business.';

	return (
		<Page title={title} lede={lede} eyebrow={mode.kind === 'saved' ? 'Saved view' : mode.kind === 'draft' ? 'Saved view · unsaved changes' : undefined}>
            <WorkSwitch selected="tasks"/>
			{mode.kind === 'draft' ? (
				// One DraftBar per person, organisation, view, base and draft filter. The saved revision is left out on
				// purpose: a conflict refresh changes it and must keep the bar's phase.
				<DraftBar key={`${stateKey}|${mode.view.id}|${mode.base}|${JSON.stringify(current)}`} viewId={mode.view.id} name={mode.view.name} base={mode.base} draft={current} draftWords={words}
					currentRevision={mode.view.revision} currentWords={describeFilter(mode.stored, referenceLabels(mode.view.references, listed))}
					unchanged={sameFilter(current, mode.stored)} scope={scope} />
			) : null}
			<section className="card work-filters" aria-label="Filters">
				<div className="work-filters__active">
					<span className="chip">{filters.owner === 'me' ? 'Assigned to you' : 'Everyone'}</span>
					<span className="chip">{statusWords[filters.status]}</span>
					{filters.projectId ? (
						<span className="chip chip--project work-chip">{labels.project(filters.projectId)}
							<Link className="work-chip__remove" href={hrefFor({ projectId: null })} aria-label="Remove the project filter">×</Link></span>
					) : null}
					{filters.tagIds.map((id) => (
						<span key={id} className="chip work-chip">{tagName(id)}
							<Link className="work-chip__remove" href={hrefFor({ tagIds: filters.tagIds.filter((t) => t !== id) })} aria-label={`Remove the tag filter ${tagName(id)}`}>×</Link></span>
					))}
					{!isDefault(filters) || view ? <Link className="work-filters__clear" href="/work">Back to my work</Link> : null}
				</div>
				{notes.map((note) => <p key={note} className="muted work-filters__note">{note}</p>)}
				<details className="disclosure">
					<summary>Filter</summary>
					{/* Keyed by what the controls stand for: their defaults are uncontrolled, so a client navigation to a
					    different filter, view or base must remount them rather than keep the previous page's checks. */}
					<form key={`${stateKey}|${mode.kind}|${view?.id ?? ''}|${mode.kind === 'saved' ? mode.view.revision : mode.kind === 'draft' ? mode.base : ''}|${JSON.stringify(current)}`} className="form work-filters__form" method="get" action="/work">
						{mode.kind !== 'plain' ? <>
							{/* The server turns this into the complete draft URL, keeping the revision the draft began from. */}
							<input type="hidden" name="view" value={mode.view.id} />
							<input type="hidden" name="base" value={mode.kind === 'saved' ? mode.view.revision : mode.base} />
							<input type="hidden" name="edit" value="1" />
						</> : null}
						<div className="row">
							<div className="field"><label htmlFor="work-owner">Owner</label>
								<select id="work-owner" name="owner" defaultValue={filters.owner}><option value="me">Assigned to you</option><option value="all">Everyone</option></select></div>
							<div className="field"><label htmlFor="work-status">Status</label>
								<select id="work-status" name="status" defaultValue={filters.status}>{statuses.map((s) => <option key={s} value={s}>{statusWords[s]}</option>)}</select></div>
							{overview.ok ? (
								<div className="field"><label htmlFor="work-project">Project</label>
									<select id="work-project" name="projectId" defaultValue={filters.projectId ?? ''}>
										<option value="">Any project</option>
										{filters.projectId && !projectOffered ? <option value={filters.projectId}>{labels.project(filters.projectId)}</option> : null}
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
				{mode.kind === 'plain' ? <SaveViewForm key={stateKey} filter={current} words={words} scope={scope} /> : null}
				{mode.kind === 'saved' ? <ManageView key={`${stateKey}|${mode.view.id}|${mode.view.revision}`} viewId={mode.view.id} name={mode.view.name} revision={mode.view.revision} scope={scope} /> : null}
			</section>

            <TaskListFeedback>
			{!tasks.ok ? (
				<Notice title="Work could not be read" tone="failed" action={{ href: returnHref, label: 'Try again' }}>
					{tasks.error.message}{tasks.error.requestId ? ` Reference: ${tasks.error.requestId}` : ''}
				</Notice>
			) : tasks.value.tasks.length === 0 ? (
				filters.offset > 0 ? (
					<Notice title="Nothing on this page" action={{ href: hrefFor(), label: 'Back to the first page' }}>The list is shorter than this page.</Notice>
				) : view ? (
					<Notice title={mode.kind === 'draft' ? 'No tasks match this draft' : 'No tasks match this view'} action={myWork}>
						{notes.length ? 'Some of its tags or its project no longer exist or could not be named; the view still filters by them.' : 'Nothing matches its filter right now.'}
					</Notice>
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
							{filters.offset > 0 ? <Link className="button button--ghost" href={hrefFor({ offset: Math.max(0, filters.offset - pageSize) })}>Previous</Link> : <span />}
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
