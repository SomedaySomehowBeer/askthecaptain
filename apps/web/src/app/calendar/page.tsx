import type { Metadata } from 'next';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';

export const metadata: Metadata = { title: 'Calendar' };

export default async function CalendarPage() {
	await requireCurrent('/calendar');
	return (
		<Page title="Calendar">
			<Notice title="No calendar connected.">The week and its preparation notes will live here once a calendar is connected.</Notice>
		</Page>
	);
}
