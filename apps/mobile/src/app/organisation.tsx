import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAccount } from '../account/AccountProvider.tsx';
import { faultLines, isSignedIn, organisationCopy, roleLabel, signedInNotices, type Action } from '../account/copy.ts';
import { returnToMyWork } from '../account/tab-entry.ts';
import { AccountPageFrame, Actions, Lines, useWaitWake } from '../components/AccountPage.tsx';
import { PlainScreen } from '../components/Screen.tsx';
import { colors, space, type } from '../theme/tokens.ts';

/** Choosing an organisation (docs/plans/expo-mobile-auth-composition-2026-09.md §4.4): the chooser while signed in but
 *  not ready, and Switch organisation from Account while ready. Rows come only from the latest applied membership list.
 *  Choosing another organisation remounts the tabs at Work (AccountStack); choosing the current one just goes back. */
export default function Organisation() {
	const account = useAccount();
	useWaitWake(account);
	const view = account.snapshot.account;
	if (!isSignedIn(view)) return null; // the guard removes this route; nothing to show in between
	const current = view.org.kind === 'chosen' ? view.org.membership.organisationId : null;
	const faults = faultLines(account.snapshot);
	const notices = [...signedInNotices(view), ...(faults.length > 0 ? [{ title: 'Unexpected problem', text: faults.join(' ') }] : [])];
	const choose = (organisationId: string) => {
		// The current one: back where Switch was opened from; with nothing to go back to, My work (E12).
		if (organisationId === current) { if (router.canGoBack()) router.back(); else returnToMyWork(); return; }
		account.send({ type: 'choose-organisation', organisationId });
	};
	const signOut: Action = { kind: 'sign-out', id: 'sign-out', label: 'Sign out', primary: false };

	const body = view.org.kind === 'loading' ? <Lines body={[organisationCopy.loading]} notices={notices} />
		: view.org.kind === 'none' ? (
			<>
				<Lines body={[organisationCopy.none]} notices={notices} />
				<Actions actions={[{ kind: 'web', id: 'web', label: 'Open Captain on the web', path: '/' }, signOut]} account={account} />
			</>
		) : (
			<>
				<Lines body={[]} notices={notices} />
				<View role="list" style={styles.list}>
					{view.memberships.map((membership) => {
						const isCurrent = membership.organisationId === current;
						return (
							<Pressable
								key={membership.organisationId} testID={`organisation-${membership.organisationId}`} role="button"
								aria-label={`${membership.organisationName}, ${roleLabel(membership)}${isCurrent ? `, ${organisationCopy.current}` : ''}`}
								aria-selected={isCurrent} onPress={() => choose(membership.organisationId)}
								style={[styles.row, isCurrent && styles.current]}
							>
								<Text style={styles.name} numberOfLines={2}>{membership.organisationName}</Text>
								<Text style={styles.role}>{roleLabel(membership)}{isCurrent ? ` · ${organisationCopy.current}` : ''}</Text>
							</Pressable>
						);
					})}
				</View>
				{view.ready ? null : <Actions actions={[signOut]} account={account} />}
			</>
		);

	if (view.ready) {
		const back = () => { if (router.canGoBack()) router.back(); else router.replace('/settings'); };
		return <PlainScreen title={organisationCopy.switchHeading} back={{ label: 'Account', onPress: back }}>{body}</PlainScreen>;
	}
	return <AccountPageFrame heading={organisationCopy.chooseHeading}>{body}</AccountPageFrame>;
}

const styles = StyleSheet.create({
	list: { gap: 8, marginBottom: 16 },
	row: { minHeight: space.rowMinHeight, borderRadius: 14, borderWidth: 1, borderColor: colors.rowLine, backgroundColor: colors.card, padding: space.rowPadding, justifyContent: 'center', gap: 2 },
	current: { backgroundColor: colors.currentView, borderColor: colors.check },
	name: { fontSize: type.body, fontWeight: '600', color: colors.heading },
	role: { fontSize: 13, color: colors.muted }
});
