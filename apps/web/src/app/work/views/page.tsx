import Link from 'next/link';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { ViewGroup } from '../../../components/ViewGroup.tsx';
export const metadata = { title: 'Work views' };

export default async function WorkViews() {
	await requireCurrent('/work/views');
	return <Page title="Work views" hideTitle>
		<ViewGroup title="For you" views={[
			{ label: 'My work', detail: 'Open tasks assigned to you', href: '/work' },
			{ label: 'Today’s brief', detail: 'Brief, questions and upcoming work', href: '/today' }
		]} />
		<ViewGroup title="Across the business" views={[
			{ label: 'All tasks', detail: 'Open tasks across people and projects', href: '/work?owner=all' },
			{ label: 'Projects & recurring duties', detail: 'Existing projects, checklists and deadline book', href: '/commitments' },
			{ label: 'Calendar', detail: 'Connected calendars and preparation', href: '/calendar' },
			{ label: 'Inbox', detail: 'Existing mail, drafts and correspondence', href: '/inbox' },
			{ label: 'Notes', detail: 'Existing notes and linked evidence', href: '/notes' }
		]} />
		<ViewGroup title="Saved views" views={[{ label: 'Saved filters', detail: 'Filter tasks by tags now; saving named views will follow.' }]} />
		<div className="row"><Link className="button button--primary" href="/work/new">New task</Link><Link className="button button--secondary" href="/commitments#new-project">New project</Link></div>
	</Page>;
}
