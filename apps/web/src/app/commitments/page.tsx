import type { Metadata } from 'next';
import { Notice } from '../../components/Notice.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';

export const metadata: Metadata = { title: 'Commitments' };

export default async function CommitmentsPage() {
	await requireCurrent('/commitments');
	return (
		<Page title="Commitments">
			<Notice title="No commitments yet.">Projects, tasks and the Obligations deadline book will live here. They arrive in the next release.</Notice>
		</Page>
	);
}
