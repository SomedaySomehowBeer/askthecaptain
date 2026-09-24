import type { Metadata } from 'next';
import Link from 'next/link';
import { Notice } from '../../../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../../../components/Page.tsx';
import { api, load } from '../../../../../lib/api.ts';
import { parseTagOffset, tagPageHref, tagPageSize, uuid } from '../../../tags/pagination.ts';
import { TagToggle } from './TagToggle.tsx';
import '../../../work.css';

export const metadata: Metadata = { title: 'Task tags' };
type TagOptions = { task: { id: string; title: string }; tags: { id: string; name: string; attached: boolean }[]; nextOffset: number | null };

/** One task's tags, one Add or Remove at a time. The task's name comes from the API, never the URL. */
export default async function TaskTagsPage({ params, searchParams }: { params: Promise<{ taskId: string }>; searchParams: Promise<{ offset?: string | string[] }> }) {
	const { taskId } = await params;
	const me = await requireCurrent(uuid.test(taskId) ? `/work/tasks/${taskId}/tags` : '/work');
	const offset = parseTagOffset((await searchParams).offset);
	if (!uuid.test(taskId) || offset === null) {
		return <Page title="Task tags"><Notice title="This link is not valid" tone="attention" action={{ href: '/work', label: 'Back to Work' }}>
			{!uuid.test(taskId) ? 'The task reference in the address is not a task.' : `Pages start at 0 and move in steps of ${tagPageSize}.`}</Notice></Page>;
	}
	const path = `/work/tasks/${taskId}/tags`;
	const options = await load(() => api<TagOptions>(`/v1/organisations/${me.organisation.organisationId}/tasks/${taskId}/tag-options?limit=${tagPageSize}&offset=${offset}`, { token: me.token }));
	if (!options.ok) {
		return options.error.status === 404 ? (
			<Page title="Task tags"><Notice title="This task cannot be tagged here" action={{ href: '/work', label: 'Back to Work' }}>
				It may no longer exist, be a checklist step, or belong to a proposed or archived project.</Notice></Page>
		) : (
			<Page title="Task tags"><Notice title="Tags could not be read" tone="failed" action={{ href: tagPageHref(path, offset) ?? path, label: 'Try again' }}>
				{options.error.message}{options.error.requestId ? ` Reference: ${options.error.requestId}` : ''}</Notice></Page>
		);
	}
	const { task, tags, nextOffset } = options.value;
	const previous = offset > 0 ? tagPageHref(path, Math.max(0, offset - tagPageSize)) : null;
	const next = tagPageHref(path, nextOffset);
	return (
		<Page title={task.title} lede="Tags on this task. Each Add or Remove changes one tag and is saved straight away.">
			{tags.length === 0 ? (
				offset > 0
					? <Notice title="Nothing on this page" action={{ href: path, label: 'Back to the first page' }}>The tag list is shorter than this page.</Notice>
					: <Notice title="No tags yet" action={{ href: '/work/tags', label: 'Add a tag' }}>Create the business's tags first, then add them here.</Notice>
			) : (
				<section className="card">
					<ul className="bare work-list" aria-label="Tags">
						{tags.map((tag) => (
							<li key={tag.id} className="work-tag-choice">
								<span className="work-tag-choice__name">{tag.name}{tag.attached ? <span className="chip chip--project">on this task</span> : null}</span>
								<TagToggle taskId={task.id} tagId={tag.id} name={tag.name} attached={tag.attached} />
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
			<div className="row"><Link className="button button--ghost" href="/work">Back to Work</Link><Link className="button button--ghost" href="/work/tags">Manage tags</Link></div>
		</Page>
	);
}
