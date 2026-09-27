import { router, useNavigation } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { accountCopy, faultLines, isSignedIn, roleLabel, signedInNotices } from '../account/copy.ts';
import { Actions, Button, Lines, useWaitWake } from '../components/AccountPage.tsx';
import { Notice } from '../components/Notice.tsx';
import { PlainScreen } from '../components/Screen.tsx';
import { colors, type } from '../theme/tokens.ts';

/** Account, opened from the avatar (plan D11: not a fourth tab; §4.5). Exists only when ready. */
export default function Settings() {
	const account = useAccount();
	useWaitWake(account);
	const navigation = useNavigation();
	const back = () => { if (navigation.canGoBack()) router.back(); else router.replace('/work'); };
	const view = account.snapshot.account;
	if (!isSignedIn(view) || view.org.kind !== 'chosen') return null; // the guard removes this route
	const membership = view.org.membership;
	const faults = faultLines(account.snapshot);
	const notices = [...signedInNotices(view), ...(faults.length > 0 ? [{ title: 'Unexpected problem', text: faults.join(' ') }] : [])];
	return (
		<PlainScreen title={accountCopy.heading} back={{ label: 'Back', onPress: back }}>
			<View style={styles.stack}>
				{view.refreshing ? <Text style={styles.muted}>{accountCopy.checking}</Text> : null}
				<View accessible style={styles.card}>
					<Text style={styles.name}>{view.user.name || view.user.email}</Text>
					{view.user.name ? <Text style={styles.muted}>{view.user.email}</Text> : null}
					<Text style={styles.org}>{membership.organisationName}</Text>
					<Text style={styles.muted}>{roleLabel(membership)}</Text>
				</View>
				<Lines body={[]} notices={notices} />
				<Button testID="account-action-switch" label={accountCopy.switch} onPress={() => router.push('/organisation')} />
				<Actions actions={[{ kind: 'sign-out', id: 'sign-out', label: 'Sign out', primary: false }]} account={account} />
				<Notice title="Other settings">{accountCopy.elsewhere}</Notice>
				<Actions actions={[{ kind: 'web', id: 'web-settings', label: accountCopy.otherSettings, path: '/settings' }]} account={account} />
			</View>
		</PlainScreen>
	);
}

const styles = StyleSheet.create({
	stack: { gap: 12 },
	card: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 4 },
	name: { fontSize: type.body, fontWeight: '600', color: colors.heading },
	org: { fontSize: type.body, fontWeight: '600', color: colors.body, marginTop: 8 },
	muted: { fontSize: 14, color: colors.muted }
});
