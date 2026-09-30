import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useAccount } from '../../account/AccountProvider.tsx';
import { invitationAcceptedText, invitationCopy, invitationRefusalText, isSignedIn, webCopy } from '../../account/copy.ts';
import type { AcceptOutcome } from '../../account/web-calls.ts';
import { AccountPageFrame, Button, LinkButton } from '../../components/AccountPage.tsx';
import { Notice } from '../../components/Notice.tsx';
import Welcome from '../welcome.tsx';
import { colors, type } from '../../theme/tokens.ts';

/** Accepting an invitation link (docs/plans/expo-web-session-2026-09.md §B.2). The invitee arrives with a token; they
 *  sign in first (the API insists the signed-in address is the invited one; sign-in returns here), then accept with one
 *  press. The organisation becomes the chosen one and the thread list opens. A refusal is definitive; no answer is
 *  not, and the page never suggests opening the single-use link again. */
export default function InvitationPage() {
 const params = useLocalSearchParams<{ token?: string | string[] }>();
 const { snapshot } = useAccount();
 const view = snapshot.account;
 const key = `${typeof params.token === 'string' ? params.token : ''}:${view.kind === 'signed-in' ? view.person.epoch : view.kind}`;
 return <AcceptInvitation key={key} />;
}

function AcceptInvitation() {
	const params = useLocalSearchParams<{ token?: string | string[] }>();
	const token = typeof params.token === 'string' && params.token.length > 0 ? params.token : null;
	const account = useAccount();
	const view = account.snapshot.account;
	const web = account.web;
	const busy = useRef(false);
	const [state, setState] = useState<{ kind: 'idle' } | { kind: 'accepting' } | { kind: 'answered'; outcome: AcceptOutcome }>({ kind: 'idle' });

	let body: React.ReactNode;
	if (view.kind === 'unverified') return <Welcome />;
	if (token === null) body = <Notice title={invitationCopy.refusedTitle}>{invitationCopy.missing}</Notice>;
	else if (Platform.OS !== 'web' || web === null) body = <Notice title={invitationCopy.heading}>{invitationCopy.signInFirst}</Notice>;
	else if (view.kind === 'checking') body = <Text style={styles.muted}>{webCopy.checking}</Text>;
	else if (!isSignedIn(view)) {
		body = (
			<View style={styles.stack}>
				<Text style={styles.body}>{invitationCopy.signInFirst}</Text>
				<LinkButton testID="invitation-sign-in" href={web.signInUrl(`/invitations/accept?token=${encodeURIComponent(token)}`)} label={webCopy.signInAction} primary />
			</View>
		);
	} else if (state.kind === 'answered') {
		const outcome = state.outcome;
		body = outcome.kind === 'accepted' ? (
			<View style={styles.stack}>
				<Text testID="invitation-accepted" style={styles.body}>{invitationAcceptedText(outcome.membership.organisationName)}</Text>
				<Button testID="invitation-open" label={invitationCopy.openThreads} primary onPress={() => router.replace('/')} />
			</View>
		) : outcome.kind === 'refused' ? <View testID="invitation-refused"><Notice title={invitationCopy.refusedTitle}>{invitationRefusalText(outcome.code)}</Notice></View>
		: outcome.kind === 'unknown' ? (
			<View style={styles.stack}>
				<View testID="invitation-unknown"><Notice title={invitationCopy.unknownTitle}>{invitationCopy.unknown}</Notice></View>
				<Button testID="invitation-organisations" label={invitationCopy.organisations} onPress={() => { account.send({ type: 'refresh' }); router.replace('/organisation'); }} />
			</View>
		) : <Text style={styles.muted}>{webCopy.sessionEnded}</Text>;
	} else {
		body = (
			<View style={styles.stack}>
				<Text style={styles.body}>{invitationCopy.ready}</Text>
				<Button testID="invitation-accept" label={state.kind === 'accepting' ? invitationCopy.accepting : invitationCopy.accept} primary disabled={state.kind === 'accepting'}
					onPress={() => { if (busy.current) return; busy.current = true; setState({ kind: 'accepting' }); void web.acceptInvitation(token).then((outcome) => setState({ kind: 'answered', outcome })); }} />
			</View>
		);
	}
	return <AccountPageFrame heading={invitationCopy.heading}>{body}</AccountPageFrame>;
}

const styles = StyleSheet.create({
	stack: { gap: 12 },
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	muted: { fontSize: 14, lineHeight: 20, color: colors.muted }
});
