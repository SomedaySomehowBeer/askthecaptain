import { useAccount } from '../account/AccountProvider.tsx';
import { welcomePage } from '../account/copy.ts';
import { requested } from '../account/requested.ts';
import { AccountPageFrame, Actions, Lines, useWaitWake } from '../components/AccountPage.tsx';

/** Every state that is not signed in (docs/plans/expo-mobile-auth-composition-2026-09.md §4.2), from the copy table.
 *  Sign in carries the tab route the app was opened at, if any (requested.ts). */
export default function Welcome() {
	const account = useAccount();
	useWaitWake(account);
	const page = welcomePage(account.snapshot, { now: account.now(), webAvailable: account.webLink('/') !== null, returnTo: requested() });
	return (
		<AccountPageFrame heading={page.heading}>
			<Lines body={page.body} notices={page.notices} />
			<Actions actions={page.actions} account={account} />
		</AccountPageFrame>
	);
}
