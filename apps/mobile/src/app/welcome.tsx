import { useLocalSearchParams } from 'expo-router';
import { Platform, Text } from 'react-native';
import { useAccount, type Account } from '../account/AccountProvider.tsx';
import { webCopy, webWelcomePage, welcomePage } from '../account/copy.ts';
import { AccountPageFrame, Actions, Button, Lines, LinkButton, useWaitWake } from '../components/AccountPage.tsx';
import { type } from '../theme/tokens.ts';
import { themedStyles } from '../theme/theme.ts';

/** Every state that is not signed in. On the web (docs/plans/expo-web-session-2026-09.md §B.2): one "Sign in with
 *  Google" link to the API's start, carrying the page the person first opened as `return_to`, and the sign-in error
 *  copy for `?error=`. On iOS and Android: the native copy table, unchanged (§4.2 of the composition contract). */
export default function Welcome() {
	const account = useAccount();
	useWaitWake(account);
	return Platform.OS === 'web' ? <WebWelcome account={account} /> : <NativeWelcome account={account} />;
}

/** Read once, from the page the browser first opened: a later route change does not alter where sign-in returns. */
const firstPage = Platform.OS === 'web' && typeof window !== 'undefined' ? `${window.location.pathname}${window.location.search}` : null;

function WebWelcome({ account }: { account: Account }) {
	const styles = useStyles();
	const params = useLocalSearchParams<{ error?: string | string[] }>();
	const page = webWelcomePage(account.snapshot, { now: account.now(), error: params.error });
	const web = account.web;
	return (
		<AccountPageFrame heading={page.heading}>
			<Lines body={page.body} notices={page.notices} />
			{page.signIn && web !== null ? <LinkButton testID="web-sign-in" href={web.signInUrl(firstPage)} label={webCopy.signInAction} primary /> : null}
			{page.retry === null ? null : <Button testID="web-try-again" label="Try again" primary disabled={page.retry.disabled !== null} reason={page.retry.disabled} onPress={() => account.send({ type: 'retry' })} />}
			{page.signIn ? <Text style={styles.muted}>{webCopy.inviteOnly}</Text> : null}
		</AccountPageFrame>
	);
}

function NativeWelcome({ account }: { account: Account }) {
	const page = welcomePage(account.snapshot, { now: account.now() });
	return (
		<AccountPageFrame heading={page.heading}>
			<Lines body={page.body} notices={page.notices} />
			<Actions actions={page.actions} account={account} />
		</AccountPageFrame>
	);
}

const useStyles = themedStyles((colors) => ({ muted: { fontSize: type.rowDetail, lineHeight: 18, color: colors.muted, marginTop: 8 } }));
