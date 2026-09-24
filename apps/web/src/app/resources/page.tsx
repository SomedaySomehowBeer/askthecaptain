import Link from 'next/link';
import { Page } from '../../components/Page.tsx';
import { Notice } from '../../components/Notice.tsx';
export const metadata = { title: 'Resources' };
export default function ResourcesPage() {
	return <Page title="Files & assets"><Notice title="The file library is not available yet.">
		Original files remain with their providers. Existing stock, people and business connections are available from Resources views.
	</Notice><Link className="button button--secondary" href="/resources/views">Browse resource views</Link></Page>;
}
