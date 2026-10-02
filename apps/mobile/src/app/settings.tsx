import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { accountCopy, faultLines, isSignedIn, roleLabel, signedInNotices, webCopy } from '../account/copy.ts';
import { Passkeys } from '../components/Passkeys.tsx';
import { Actions, Button, Lines, RevokeOthers, useWaitWake } from '../components/AccountPage.tsx';
import { PlainScreen } from '../components/Screen.tsx';
import Welcome from './welcome.tsx';
import { type } from '../theme/tokens.ts';
import { themedStyles } from '../theme/theme.ts';

/** Account, opened from the avatar (docs/plans/expo-web-session-2026-09.md §B.2): who you are, Switch organisation,
 *  Sign out, Sign out everywhere else, and passkey registration/removal. Organisation export and deletion come later. */
export default function Settings() {
	const styles = useStyles();
	const account = useAccount();
	useWaitWake(account);
	// Back to the page Account was opened from; with nothing to go back to, the thread list.
	const back = () => { if (router.canGoBack()) router.back(); else router.replace('/'); };
	const view = account.snapshot.account;
	if (view.kind === 'checking' || view.kind === 'starting') {
		return <PlainScreen title={accountCopy.heading} back={{ label: 'Back', onPress: back }}><Text style={styles.muted}>{webCopy.checking}</Text></PlainScreen>;
	}
	if (view.kind === 'unverified') return <Welcome />;
	if (!isSignedIn(view)) return null;
	const membership = view.org.kind === 'chosen' ? view.org.membership : null;
	const faults = faultLines(account.snapshot);
	const notices = [...signedInNotices(view), ...(faults.length > 0 ? [{ title: 'Unexpected problem', text: faults.join(' ') }] : [])];
	return (
		<PlainScreen title={accountCopy.heading} back={{ label: 'Back', onPress: back }}>
			<View style={styles.stack}>
				{view.refreshing ? <Text style={styles.muted}>{accountCopy.checking}</Text> : null}
				<View accessible style={styles.card}>
					<Text style={styles.name}>{view.user.name || view.user.email}</Text>
					{view.user.name ? <Text style={styles.muted}>{view.user.email}</Text> : null}
					<Text testID="account-organisation" style={styles.org}>{membership?.organisationName ?? 'No organisation selected'}</Text>
					<Text style={styles.muted}>{membership === null ? '' : roleLabel(membership)}</Text>
				</View>
				<Lines body={[]} notices={notices} />
				<Button testID="account-action-switch" label={accountCopy.switch} onPress={() => router.push('/organisation')} />
				<Actions actions={[{ kind: 'sign-out', id: 'sign-out', label: 'Sign out', primary: false }]} account={account} />
				<RevokeOthers account={account} />
				<Button testID="account-members" label="Members and invitations" disabled={!membership || membership.role === 'member'} reason="Choose an organisation you own or administer." onPress={() => router.push('/members')} />
				<Button testID="account-notifications" label="Notifications" onPress={() => router.push('/settings/notifications')} />
				<Passkeys key={view.person.epoch} web={account.web} now={account.now} />
			</View>
		</PlainScreen>
	);
}

const useStyles = themedStyles((colors) => ({
	stack: { gap: 12 },
	card: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 4 },
	name: { fontSize: type.body, fontWeight: '600', color: colors.heading },
	org: { fontSize: type.body, fontWeight: '600', color: colors.body, marginTop: 8 },
	muted: { fontSize: 14, lineHeight: 20, color: colors.muted }
}));
