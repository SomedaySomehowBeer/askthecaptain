import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAccount, type Account } from '../account/AccountProvider.tsx';
import { accountCopy, faultLines, isSignedIn, passkeyDetail, roleLabel, signedInNotices, webCopy } from '../account/copy.ts';
import type { PasskeyList } from '../account/web-calls.ts';
import { Actions, Button, Lines, RevokeOthers, useWaitWake } from '../components/AccountPage.tsx';
import { Notice } from '../components/Notice.tsx';
import { PlainScreen } from '../components/Screen.tsx';
import { colors, type } from '../theme/tokens.ts';

/** Account, opened from the avatar (docs/plans/expo-web-session-2026-09.md §B.2): who you are, Switch organisation,
 *  Sign out, Sign out everywhere else, and the passkeys list. Adding and removing passkeys, and organisation export and
 *  deletion, come later. */
export default function Settings() {
	const account = useAccount();
	useWaitWake(account);
	// Back to the page Account was opened from; with nothing to go back to, the thread list.
	const back = () => { if (router.canGoBack()) router.back(); else router.replace('/'); };
	const view = account.snapshot.account;
	if (view.kind === 'checking' || view.kind === 'starting') {
		return <PlainScreen title={accountCopy.heading} back={{ label: 'Back', onPress: back }}><Text style={styles.muted}>{webCopy.checking}</Text></PlainScreen>;
	}
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
					<Text testID="account-organisation" style={styles.org}>{membership.organisationName}</Text>
					<Text style={styles.muted}>{roleLabel(membership)}</Text>
				</View>
				<Lines body={[]} notices={notices} />
				<Button testID="account-action-switch" label={accountCopy.switch} onPress={() => router.push('/organisation')} />
				<Actions actions={[{ kind: 'sign-out', id: 'sign-out', label: 'Sign out', primary: false }]} account={account} />
				<RevokeOthers account={account} />
				<Passkeys account={account} personEpoch={view.person.epoch} />
			</View>
		</PlainScreen>
	);
}

type PasskeysState = { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; list: PasskeyList };

/** The person's passkeys, read once per mount on the web (`GET /v1/me/passkeys`); read-only in this increment. A
 *  failed read is said as one, never as "no passkeys". Native lists nothing and says so. */
function Passkeys({ account, personEpoch }: { account: Account; personEpoch: string }) {
	const web = account.web;
	const [state, setState] = useState<PasskeysState>({ kind: 'loading' });
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		if (web === null) return undefined;
		let live = true;
		setState({ kind: 'loading' });
		void web.passkeys().then((answer) => {
			if (!live) return;
			setState(answer.ok ? { kind: 'loaded', list: answer.value } : { kind: 'failed' });
		});
		return () => { live = false; };
	}, [web, personEpoch, attempt]);
	return (
		<View testID="account-passkeys" style={styles.section}>
			<Text role="heading" style={styles.sectionTitle}>{accountCopy.passkeys}</Text>
			<Text style={styles.muted}>{accountCopy.passkeysIntro}</Text>
			{web === null ? <Text style={styles.muted}>{accountCopy.passkeysNative}</Text>
				: state.kind === 'loading' ? <Text testID="account-passkeys-loading" style={styles.muted}>{accountCopy.passkeysLoading}</Text>
				: state.kind === 'failed' ? (
					<View style={styles.stack}>
						<View testID="account-passkeys-failed"><Notice title={accountCopy.passkeys}>{accountCopy.passkeysFailed}</Notice></View>
						<Button testID="account-passkeys-try-again" label={accountCopy.tryAgain} onPress={() => setAttempt((n) => n + 1)} />
					</View>
				)
				: !state.list.available ? <Text testID="account-passkeys-unavailable" style={styles.body}>{accountCopy.passkeysUnavailable}</Text>
				: state.list.passkeys.length === 0 ? <Text testID="account-passkeys-none" style={styles.body}>{accountCopy.passkeysNone}</Text>
				: (
					<View role="list" style={styles.card}>
						{state.list.passkeys.map((passkey) => (
							<View key={passkey.id} role="listitem" accessible aria-label={`${passkey.name}, ${passkeyDetail(passkey)}`} testID={`account-passkey-${passkey.id}`} style={styles.passkey}>
								<Text style={styles.name}>{passkey.name}</Text>
								<Text style={styles.muted}>{passkeyDetail(passkey)}</Text>
							</View>
						))}
					</View>
				)}
			{web === null ? null : <Text style={styles.muted}>{accountCopy.passkeysManage}</Text>}
		</View>
	);
}

const styles = StyleSheet.create({
	stack: { gap: 12 },
	section: { gap: 8, marginTop: 8 },
	sectionTitle: { fontSize: 18, fontWeight: '600', color: colors.heading },
	card: { backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 4 },
	passkey: { gap: 2, paddingVertical: 6 },
	name: { fontSize: type.body, fontWeight: '600', color: colors.heading },
	org: { fontSize: type.body, fontWeight: '600', color: colors.body, marginTop: 8 },
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	muted: { fontSize: 14, lineHeight: 20, color: colors.muted }
});
