import type { Metadata } from 'next';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';

export const metadata: Metadata = { title: 'Inbox' };

export default async function InboxPage() {
	await requireCurrent('/inbox');
	return (
		<Page title="Inbox">
			<Notice title="Captain has no mail to read yet.">Nothing arrives here until Google is connected. Triage, drafts and the outbox will live on this page.</Notice>
		</Page>
	);
}
