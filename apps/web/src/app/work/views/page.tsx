import Link from 'next/link';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { ViewGroup } from '../../../components/ViewGroup.tsx';
export const metadata = { title: 'Work views' };

export default async function WorkViews() {
	await requireCurrent('/work/views');
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
		<ViewGroup title="Saved views" views={[{ label: 'Saved filters', detail: 'Filter tasks by tags now; saving named views will follow.' }]} />
		<div className="row"><Link className="button button--primary" href="/work/new">New task</Link><Link className="button button--secondary" href="/work/projects/new">New project</Link></div>
	</Page>;
}
