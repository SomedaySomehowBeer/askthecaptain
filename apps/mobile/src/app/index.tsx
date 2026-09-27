import { Redirect } from 'expo-router';
import { useAccount } from '../account/AccountProvider.tsx';
import { routeFor } from '../account/copy.ts';

/** `/` goes where the account allows (§4.1): Work → My work when ready (plan D11), otherwise the chooser or welcome.
 *  It can never reach a tab before the guards allow it. */
export default function Home() {
	const { snapshot } = useAccount();
	return <Redirect href={routeFor(snapshot.account)} />;
}
