import type { Metadata } from 'next';
import { Notice } from '../components/Notice.tsx';
import { Page, requireCurrent } from '../components/Page.tsx';

export const metadata: Metadata = { title: 'Today' };

/** The front page answers one question: does anything need me. Nothing can need anyone until a
 *  connection exists, and the page says so instead of showing an empty list as if it were a quiet day. */
export default async function TodayPage() {
	const me = await requireCurrent('/');
	const first = me.me.user.name.split(' ')[0] || me.me.user.email;
	return (
		<Page title={`Morning, ${first}.`} lede={me.organisation.organisationName}>
			<section className="stack">
				<h2>Waiting on you</h2>
				<Notice title="Captain is not watching anything yet.">
					Nothing can need you until Google is connected. Connecting mail and calendar is the next step, and it is coming in the next release.
				</Notice>
			</section>
		</Page>
	);
}
