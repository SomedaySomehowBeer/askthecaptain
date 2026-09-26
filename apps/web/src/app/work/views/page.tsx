import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { ViewGroup } from '../../../components/ViewGroup.tsx';
import { api, load, type Project } from '../../../lib/api.ts';
import { projectLabel } from '../filters.ts';
import { describeRow, parseViewOffset, savedHref, viewPageSize, viewsHref, type SavedViewPage } from '../saved-views.ts';
import { tagRowDetail, tagViewHref } from '../tag-views.ts';
import type { TagPage } from '../types.ts';
import '../work.css';
export const metadata = { title: 'Work views' };

/** The two independent group cursors on this page. Either may be null when its URL value cannot be a page; each
 *  group then shows its own "page does not exist" state, and the other group's links leave that value out. */
type Cursors = { offset: number | null; tagOffset: number | null };

/** Every organisation tag as a Work link by ID (contract `default-business-views-2026-09.md`), 50 to a page in the
 *  server's name order. No count, pin or preset; nothing is created here. */
async function TagViews({ org, token, cursors }: { org: string; token: string; cursors: Cursors }) {
	const { offset, tagOffset } = cursors;
	const firstTagPage = viewsHref(offset, 0) ?? '/work/views';
	if (tagOffset === null) {
		return <section className="view-group" aria-label="By tag"><h2>By tag</h2>
			<Notice title="That page of tags does not exist" tone="attention" action={{ href: firstTagPage, label: 'Show the first page of tags' }}>Tags are listed 50 at a time.</Notice></section>;
	}
	const page = await load(() => api<TagPage>(`/v1/organisations/${org}/tags?offset=${tagOffset}&limit=${viewPageSize}`, { token }));
	if (!page.ok) {
		return <section className="view-group" aria-label="By tag"><h2>By tag</h2>
			<Notice title="Tags could not be read" tone="failed" action={{ href: viewsHref(offset, tagOffset) ?? firstTagPage, label: 'Try again' }}>
				{page.error.message}{page.error.requestId ? ` Reference: ${page.error.requestId}` : ''} No tag views are shown in their place.
			</Notice></section>;
	}
	const { tags, nextOffset } = page.value;
	const previous = tagOffset > 0 ? viewsHref(offset, Math.max(0, tagOffset - viewPageSize)) : null;
	const next = nextOffset === null ? null : viewsHref(offset, nextOffset);
	return <section className="view-group" aria-label="By tag">
		<h2>By tag</h2>
		{tags.length === 0 ? (
			tagOffset > 0
				? <Notice title="Nothing on this page" action={{ href: firstTagPage, label: 'Back to the first page of tags' }}>The tag list is shorter than this page.</Notice>
				: <Notice title="No tags yet" action={{ href: '/work/tags', label: 'Open Tags' }}>Each tag you add appears here as a view of everyone&rsquo;s open work with that tag, for example Production, Marketing, Sales or Admin/reporting.</Notice>
		) : (
			<ul className="bare view-group__rows">{tags.map((tag) => <li key={tag.id}>
				<Link className="view-row" href={tagViewHref(tag.id)}><span><strong>{tag.name}</strong><small>{tagRowDetail}</small></span><span aria-hidden="true">›</span></Link>
			</li>)}</ul>
		)}
		{previous || next ? (
			<nav className="row row--between work-views__pages" aria-label="Tag pages">
				{previous ? <Link className="button button--ghost" href={previous}>Previous</Link> : <span />}
				{next ? <Link className="button button--ghost" href={next}>Next</Link> : null}
			</nav>
		) : null}
	</section>;
}

/** Shapes, not rows: nothing here claims how many tags there are. */
function TagViewsLoading() {
	return <section className="view-group" aria-label="By tag" aria-busy="true"><h2>By tag</h2>
		<div className="card" aria-hidden="true"><div className="skeleton" style={{ width: '40%' }} /><div className="skeleton" style={{ width: '55%' }} /></div>
		<p className="visually-hidden" role="status">Reading tags…</p></section>;
}

/** The person's own saved views (D26), 50 to a page in name order. Names come from the loaded tag and
 *  project pages only for display; the view itself always filters by its stored IDs. */
async function SavedViews({ org, token, cursors }: { org: string; token: string; cursors: Cursors }) {
	const { offset, tagOffset } = cursors;
	const firstViewPage = viewsHref(0, tagOffset) ?? '/work/views';
	if (offset === null) {
		return <section className="view-group" aria-label="Saved views"><h2>Saved views</h2>
			<Notice title="That page of saved views does not exist" tone="attention" action={{ href: firstViewPage, label: 'Show the first page' }}>Saved views are listed 50 at a time.</Notice></section>;
	}
	const [page, tags, projects] = await Promise.all([
		load(() => api<SavedViewPage>(`/v1/organisations/${org}/views?offset=${offset}&limit=${viewPageSize}`, { token })),
		load(() => api<TagPage>(`/v1/organisations/${org}/tags?limit=100`, { token })),
		load(() => api<{ projects: Project[] }>(`/v1/organisations/${org}/projects?limit=50`, { token }))
	]);
	if (!page.ok) {
		return <section className="view-group" aria-label="Saved views"><h2>Saved views</h2>
			<Notice title="Your saved views could not be read" tone="failed" action={{ href: viewsHref(offset, tagOffset) ?? firstViewPage, label: 'Try again' }}>
				{page.error.message}{page.error.requestId ? ` Reference: ${page.error.requestId}` : ''} Your views have not been changed.
			</Notice></section>;
	}
	const { views, nextOffset } = page.value;
	const listed = {
		tags: new Map((tags.ok ? tags.value.tags : []).map((t) => [t.id, t.name])),
		projects: new Map((projects.ok ? projects.value.projects : []).map((p) => [p.id, projectLabel(p)]))
	};
	const previous = offset > 0 ? viewsHref(Math.max(0, offset - viewPageSize), tagOffset) : null;
	const next = nextOffset === null ? null : viewsHref(nextOffset, tagOffset);
	return <section className="view-group" aria-label="Saved views">
		<h2>Saved views</h2>
		{views.length === 0 ? (
			offset > 0
				? <Notice title="Nothing on this page" action={{ href: firstViewPage, label: 'Back to the first page' }}>The list is shorter than this page.</Notice>
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
	const search = await searchParams;
	// Two independent cursors; a repeated or malformed value makes only its own group say the page does not exist.
	const cursors: Cursors = { offset: parseViewOffset(search.offset), tagOffset: parseViewOffset(search.tagOffset) };
	const org = me.organisation.organisationId;
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
		<Suspense fallback={<TagViewsLoading />}>
			<TagViews org={org} token={me.token} cursors={cursors} />
		</Suspense>
		<Suspense fallback={<SavedViewsLoading />}>
			<SavedViews org={org} token={me.token} cursors={cursors} />
		</Suspense>
		<div className="row"><Link className="button button--primary" href="/work/new">New task</Link><Link className="button button--secondary" href="/work/projects/new">New project</Link></div>
	</Page>;
}
