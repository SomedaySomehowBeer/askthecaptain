import { useLocalSearchParams } from 'expo-router';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useAccount } from '../../account/AccountProvider.tsx';
import { stepUpCopy } from '../../account/copy.ts';
import type { WebCalls } from '../../account/web-calls.ts';
import { AccountPageFrame, Button, LinkButton } from '../../components/AccountPage.tsx';
import { Notice } from '../../components/Notice.tsx';
import { type } from '../../theme/tokens.ts';
import { themedStyles } from '../../theme/theme.ts';

/** The passkey step-up between Google and the session (docs/plans/expo-web-session-2026-09.md §A.2, §B.2). The API
 *  sent the browser here with the `captain_stepup` cookie; the page asks the API for assertion options, has the
 *  browser present the passkey, and sends the assertion back. A verified passkey sets the session cookie, so the page
 *  then opens `returnTo` as a fresh load: the account reads `/v1/me` anew with the cookie. Every failure is said in
 *  words with the way out. On iOS and Android there is nothing to do: the step-up happens in the sign-in browser. */
export default function Passkey() {
	const { web } = useAccount();
	const params = useLocalSearchParams<{ native?: string }>();
	if (Platform.OS !== 'web' || web === null) {
		return <AccountPageFrame heading={stepUpCopy.heading}><Notice title={stepUpCopy.heading}>{stepUpCopy.native}</Notice></AccountPageFrame>;
	}
	return <StepUp web={web} native={params.native === '1'} />;
}

type Phase = 'starting' | 'waiting' | 'checking' | 'done' | 'failed';

function StepUp({ web, native }: { web: WebCalls; native: boolean }) {
	const styles = useStyles();
	const [phase, setPhase] = useState<Phase>('starting');
	const [message, setMessage] = useState('');
	const [target, setTarget] = useState<string | null>(null);
	const busy = useRef(false);
	const live = useRef(true);
	const [restart, setRestart] = useState(false);
	const attempt = async () => {
		if (busy.current) return;
		busy.current = true;
		setPhase('waiting'); setMessage('');
		try {
			const got = await web.stepUpOptions();
			if (!live.current) return;
			if (!got.ok) {
				setPhase('failed'); setRestart(true);
				setMessage(got.kind === 'refused' || got.kind === 'unauthorised' ? stepUpCopy.expired : stepUpCopy.optionsFailed);
				return;
			}
			let response: unknown;
			try { const { startAuthentication } = await import('@simplewebauthn/browser'); response = await startAuthentication({ optionsJSON: got.value.options as PublicKeyCredentialRequestOptionsJSON }); }
			catch (error) { setPhase('failed'); setMessage(error instanceof Error && error.name === 'NotAllowedError' ? stepUpCopy.dismissed : stepUpCopy.unsupported); return; }
			if (!live.current) return;
			setPhase('checking');
			const verified = await web.stepUpVerify(response, native);
			if (!live.current) return;
			if (!verified.ok) { setPhase('failed'); setRestart(true); setMessage(verified.kind === 'refused' || verified.kind === 'unauthorised' ? stepUpCopy.verifyFailed : stepUpCopy.optionsFailed); return; }
			setTarget(verified.value.returnTo); setPhase('done');
			window.location.assign(verified.value.returnTo);
		} finally { busy.current = false; }
	};
	useEffect(() => { live.current = true; if (phase === 'starting') void attempt(); // eslint-disable-line react-hooks/exhaustive-deps
	return () => { live.current = false; }; }, []);
	return (
		<AccountPageFrame heading={stepUpCopy.heading}>
			<View style={styles.stack}>
				<Text style={styles.body}>{stepUpCopy.body}</Text>
				{phase === 'waiting' ? <Text testID="step-up-waiting" style={styles.muted}>{stepUpCopy.waiting}</Text> : null}
				{phase === 'checking' ? <Text testID="step-up-checking" style={styles.muted}>{stepUpCopy.checking}</Text> : null}
				{phase === 'done' ? <Text testID="step-up-done" role="status" style={styles.muted}>{stepUpCopy.done}</Text> : null}
				{phase === 'failed' ? <View testID="step-up-failed"><Notice title={stepUpCopy.heading}>{message}</Notice></View> : null}
				{phase === 'done' || restart ? null : (
					<Button testID="step-up-use" label={phase === 'failed' ? stepUpCopy.tryAgain : stepUpCopy.use} primary
						disabled={phase === 'waiting' || phase === 'checking'} onPress={() => { void attempt(); }} />
				)}
				{native ? <Text style={styles.muted}>To start over, close this window and sign in again from the app.</Text> : <LinkButton testID="step-up-start-over" href={target ?? '/welcome'} label={stepUpCopy.startOver} />}
			</View>
		</AccountPageFrame>
	);
}

const useStyles = themedStyles((colors) => ({
	stack: { gap: 12 },
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	muted: { fontSize: 14, lineHeight: 20, color: colors.muted }
}));
