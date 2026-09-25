import Link from 'next/link';
import { Page, requireCurrent } from './Page.tsx';

/** The old personal-assistant pages Captain no longer offers (plan §1, #133). A retired page says so
 *  plainly to a signed-in person and points to the workspace. It reads nothing from the retired
 *  source: no mail, calendar or note is fetched to render it. */
export type RetiredFeatureName = 'today' | 'inbox' | 'calendar' | 'notes';

export const retiredFeatures: Record<RetiredFeatureName, { title: string; what: string }> = {
	today: { title: 'Today', what: 'The Today page, with its morning brief and question box, is no longer part of Captain.' },
	inbox: { title: 'Inbox', what: 'The mail Inbox, with its triage and reply drafts, is no longer part of Captain.' },
	calendar: { title: 'Calendar', what: 'The synced calendar and meeting preparation are no longer part of Captain.' },
	notes: { title: 'Notes', what: 'Notes are no longer part of Captain.' }
};

export async function RetiredFeature({ feature, returnTo }: { feature: RetiredFeatureName; returnTo: string }) {
	await requireCurrent(returnTo);
	const { title, what } = retiredFeatures[feature];
	return (
		<Page title={title}>
			<div className="card notice notice--quiet" role="status">
				<h2>This part of Captain has been retired</h2>
				<p className="secondary">{what} Captain now keeps the business’s shared work, equipment, stock and people. Retiring this page does not delete anything.</p>
				<div className="row">
					<Link className="button button--primary" href="/work">Go to Work</Link>
					<Link className="button button--secondary" href="/resources/views">Resources</Link>
				</div>
			</div>
		</Page>
	);
}
