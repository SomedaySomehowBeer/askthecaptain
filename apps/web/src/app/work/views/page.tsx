import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { ViewGroup } from '../../../components/ViewGroup.tsx';
import { api, load, type Project } from '../../../lib/api.ts';
import { projectLabel } from '../filters.ts';
import { describeRow, parseViewOffset, savedHref, viewPageHref, viewPageSize, type SavedViewPage } from '../saved-views.ts';
import type { TagPage } from '../types.ts';
import '../work.css';
export const metadata = { title: 'Work views' };

/** The person's own saved views (D26), 50 to a page in name order. Names come from the loaded tag and
 *  project pages only for display; the view itself always filters by its stored IDs. */
async function SavedViews({ org, token, offset }: { org: string; token: string; offset: number | null }) {
	if (offset === null) {
		return <section className="view-group" aria-label="Saved views"><h2>Saved views</h2>
			<Notice title="That page of saved views does not exist" tone="attention" action={{ href: '/work/views', label: 'Show the first page' }}>Saved views are listed 50 at a time.</Notice></section>;
	}
	const [page, tags, projects] = await Promise.all([
		load(() => api<SavedViewPage>(`/v1/organisations/${org}/views?offset=${offset}&limit=${viewPageSize}`, { token })),
		load(() => api<TagPage>(`/v1/organisations/${org}/tags?limit=100`, { token })),
		load(() => api<{ projects: Project[] }>(`/v1/organisations/${org}/projects?limit=50`, { token }))
	]);
	if (!page.ok) {
		return <section className="view-group" aria-label="Saved views"><h2>Saved views</h2>
			<Notice title="Your saved views could not be read" tone="failed" action={{ href: viewPageHref(offset) ?? '/work/views', label: 'Try again' }}>
				{page.error.message}{page.error.requestId ? ` Reference: ${page.error.requestId}` : ''} Your views have not been changed.
			</Notice></section>;
	}
	const { views, nextOffset } = page.value;
	const listed = {
		tags: new Map((tags.ok ? tags.value.tags : []).map((t) => [t.id, t.name])),
		projects: new Map((projects.ok ? projects.value.projects : []).map((p) => [p.id, projectLabel(p)]))
	};
	const previous = offset > 0 ? viewPageHref(Math.max(0, offset - viewPageSize)) : null;
	const next = viewPageHref(nextOffset);
	return <section className="view-group" aria-label="Saved views">
		<h2>Saved views</h2>
		{views.length === 0 ? (
			offset > 0
				? <Notice title="Nothing on this page" action={{ href: '/work/views', label: 'Back to the first page' }}>The list is shorter than this page.</Notice>
				: <Notice title="No saved views yet">Filter your work, then choose <strong>Save this view</strong> to keep that filter here. Only you can see your saved views.</Notice>
		) : (
			<ul className="bare view-group__rows">{views.map((view) => <li key={view.id}>
				<Link className="view-row" href={savedHref(view.id)}><span><strong>{view.name}</strong><small>{describeRow(view, listed)}</small></span><span aria-hidden="true">›</span></Link>
			</li>)}</ul>
		)}
		{previous || next ? (
			<nav className="row row--between work-views__pages" aria-label="Saved view pages">
				{previous ? <Link className="button button--ghost" href={previous}>Previous</Link> : <span />}
				{next ? <Link className="button button--ghost" href={next}>Next</Link> : null}
			</nav>
		) : null}
	</section>;
}

/** Shapes, not rows: nothing here claims how many views there are. */
function SavedViewsLoading() {
	return <section className="view-group" aria-label="Saved views" aria-busy="true"><h2>Saved views</h2>
		<div className="card" aria-hidden="true"><div className="skeleton" style={{ width: '45%' }} /><div className="skeleton" style={{ width: '65%' }} /></div>
		<p className="visually-hidden" role="status">Reading your saved views…</p></section>;
}

export default async function WorkViews({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const me = await requireCurrent('/work/views');
	const offset = parseViewOffset((await searchParams).offset);
	return <Page title="Work views" hideTitle>
		<ViewGroup title="For you" views={[
			{ label: 'My work', detail: 'Open tasks assigned to you', href: '/work' }
		]} />
		<ViewGroup title="Across the business" views={[
			{ label: 'All tasks', detail: 'Open tasks across people and projects', href: '/work?owner=all' },
			{ label: 'Tags', detail: 'Add and rename the shared labels on tasks', href: '/work/tags' },
			{ label: 'Projects', detail: 'Work that shares an outcome', href: '/work/projects' },
			{ label: 'Recurring work', detail: 'Rules and their task occurrences', href: '/work/series' }
		]} />
		<Suspense fallback={<SavedViewsLoading />}>
			<SavedViews org={me.organisation.organisationId} token={me.token} offset={offset} />
		</Suspense>
		<div className="row"><Link className="button button--primary" href="/work/new">New task</Link><Link className="button button--secondary" href="/work/projects/new">New project</Link></div>
	</Page>;
}
