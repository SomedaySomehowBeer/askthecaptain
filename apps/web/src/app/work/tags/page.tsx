import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import type { TagPage } from '../types.ts';
import { parseTagOffset, tagPageHref, tagPageSize } from './pagination.ts';
import { CreateTagForm, RenameTagForm } from './TagForms.tsx';
import '../work.css';

export const metadata: Metadata = { title: 'Tags' };

/** The organisation's shared labels (D7): add one, or rename one for everyone. Deleting is later. */
export default async function TagsPage({ searchParams }: { searchParams: Promise<{ offset?: string | string[] }> }) {
	const me = await requireCurrent('/work/tags');
	const offset = parseTagOffset((await searchParams).offset);
	if (offset === null) {
		return <Page title="Tags"><Notice title="That page of tags does not exist" tone="attention" action={{ href: '/work/tags', label: 'Show the first page' }}>
			Pages start at 0 and move in steps of {tagPageSize}.</Notice></Page>;
	}
	const tags = await load(() => api<TagPage>(`/v1/organisations/${me.organisation.organisationId}/tags?limit=${tagPageSize}&offset=${offset}`, { token: me.token }));
	const previous = offset > 0 ? tagPageHref('/work/tags', Math.max(0, offset - tagPageSize)) : null;
	const next = tags.ok ? tagPageHref('/work/tags', tags.value.nextOffset) : null;
	return (
		<Page title="Tags" lede="Shared labels help you organise and filter tasks across projects.">
			<section className="card"><CreateTagForm /></section>
			{!tags.ok ? (
				<Notice title="Tags could not be read" tone="failed" action={{ href: tagPageHref('/work/tags', offset) ?? '/work/tags', label: 'Try again' }}>
					{tags.error.message}{tags.error.requestId ? ` Reference: ${tags.error.requestId}` : ''}
				</Notice>
			) : tags.value.tags.length === 0 ? (
				offset > 0
					? <Notice title="Nothing on this page" action={{ href: '/work/tags', label: 'Back to the first page' }}>The list is shorter than this page.</Notice>
					: <Notice title="No tags yet">Add the first one above, then add it to tasks from Work.</Notice>
			) : (
				<section className="card">
					<ul className="bare work-list" aria-label="Tags">
						{tags.value.tags.map((tag) => (
							<li key={tag.id} className="work-tag-row">
								<span className="work-tag-row__name">{tag.name}</span>
								<Link className="work-tag-row__use" href={`/work?owner=all&status=all&tagId=${tag.id}`}>Tasks with this tag</Link>
								<details className="disclosure"><summary>Rename</summary><RenameTagForm id={tag.id} name={tag.name} /></details>
							</li>
						))}
					</ul>
					{previous || next ? (
						<nav className="row row--between" aria-label="Pages">
							{previous ? <Link className="button button--ghost" href={previous}>Previous</Link> : <span />}
							{next ? <Link className="button button--ghost" href={next}>Next</Link> : null}
						</nav>
					) : null}
				</section>
			)}
		</Page>
	);
}
