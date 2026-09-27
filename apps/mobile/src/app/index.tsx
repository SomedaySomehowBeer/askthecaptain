import { Redirect } from 'expo-router';
import { useAccount } from '../account/AccountProvider.tsx';
import { routeFor, tabEntryAction } from '../account/copy.ts';
import { anchored } from '../components/SectionStack.tsx';

/** `/` goes where the account allows (§4.1): Work → My work when ready (plan D11), otherwise the chooser or welcome.
 *  It can never reach a tab before the guards allow it. Going to Work is an app-initiated tab entry, anchored on iOS
 *  and Android like the others (docs/plans/expo-mobile-native-navigation-2026-09.md §3.2, E7). */
export default function Home() {
	const { snapshot } = useAccount();
	const href = routeFor(snapshot.account);
	return <Redirect href={href} withAnchor={tabEntryAction(anchored, { intent: 'arrive', href }).options.withAnchor} />;
}
