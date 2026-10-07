import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { accountCopy, faultLines, isSignedIn, roleLabel, signedInNotices, webCopy } from '../account/copy.ts';
import { Passkeys } from '../components/Passkeys.tsx';
import { Actions, Button, Lines, RevokeOthers, useWaitWake } from '../components/AccountPage.tsx';
import { PlainScreen } from '../components/Screen.tsx';
import Welcome from './welcome.tsx';
import { type } from '../theme/tokens.ts';
import { initials } from '../threads/Presentation.tsx';
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
					<View style={styles.row}>
						<View aria-hidden style={styles.avatar}><Text style={styles.initials}>{initials(view.user.name || view.user.email)}</Text></View>
						<View style={styles.who}><Text style={styles.name}>{view.user.name || view.user.email}</Text>
							{view.user.name ? <Text style={styles.detail}>{view.user.email}</Text> : null}</View>
					</View>
					<View style={[styles.row, styles.orgRow]}>
						<Text testID="account-organisation" style={[styles.org, styles.who]}>{membership?.organisationName ?? 'No organisation selected'}</Text>
						<Text style={styles.role}>{membership === null ? '' : roleLabel(membership)}</Text>
					</View>
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

/** Prototype frames 12 and 13: the person as a Team row (a 32 pt initials avatar, 13 pt bold name, 11 pt detail) and the
 *  organisation with the role on the right; the actions in the R3 button style. */
const useStyles = themedStyles((colors) => ({
	stack: { gap: 10 },
	card: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.line },
	row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, minHeight: 58 },
	orgRow: { borderTopWidth: 1, borderColor: colors.rowLine },
	avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.sage, alignItems: 'center', justifyContent: 'center' },
	initials: { fontSize: 11, fontWeight: '700', color: colors.sageText },
	who: { flex: 1, minWidth: 0 },
	name: { fontSize: type.rowTitle, lineHeight: type.rowTitleLine, fontWeight: '700', color: colors.heading },
	detail: { fontSize: type.rowDetail, lineHeight: type.rowDetailLine, color: colors.muted },
	org: { fontSize: type.rowTitle, lineHeight: type.rowTitleLine, fontWeight: '700', color: colors.heading },
	role: { fontSize: type.rowDetail, fontWeight: '700', color: colors.muted },
	muted: { fontSize: type.small, lineHeight: type.smallLine, color: colors.muted }
}));
