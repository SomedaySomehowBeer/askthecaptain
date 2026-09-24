import Link from 'next/link';
import { Page } from '../../../components/Page.tsx';
import { ViewGroup } from '../../../components/ViewGroup.tsx';
export const metadata = { title: 'Resource views' };
export default function ResourceViews() {
	return <Page title="Resource views" hideTitle>
		<ViewGroup title="Libraries" views={[
			{ label: 'Files & assets', detail: 'File library availability', href: '/resources' },
			{ label: 'Inventory', detail: 'Existing stock counts and stocktakes', href: '/resources/inventory' }
		]} />
		<ViewGroup title="Planning" views={[{ label: 'Equipment schedule', detail: 'Reservations, preparation and maintenance' }]} />
		<ViewGroup title="Business" views={[
			{ label: 'People', detail: 'Contacts and companies', href: '/settings/contacts' },
			{ label: 'Connections', detail: 'Business accounts in Settings, including Xero', href: '/settings/connections' },
			{ label: 'Reports', detail: 'Shared business reporting' }
		]} />
		<Link className="button button--primary" href="/resources/inventory">Record a stock count</Link>
	</Page>;
}
