import { useEffect, useState, type ReactNode } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Action, Line } from '../account/copy.ts';
import { copy, nextWake, snapshotWaits } from '../account/copy.ts';
import type { Account } from '../account/AccountProvider.tsx';
import { colors, space, type } from '../theme/tokens.ts';
import { Notice } from './Notice.tsx';

/** The account pages' shared parts (docs/plans/expo-mobile-auth-composition-2026-09.md §4.2): the plain page language
 *  (26 pt heading, notices, 44 pt targets), actions from the copy table, and the wait re-render timer. */

/** Re-renders when the earliest server wait in the snapshot ends, so a disabled Try again becomes enabled. UI only: it
 *  sends nothing, and the reducer still refuses a press made before the deadline. Measured on the snapshot's clock. */
export function useWaitWake(account: Account): void {
	const [, setTick] = useState(0);
	const delay = nextWake(snapshotWaits(account.snapshot), account.now());
	useEffect(() => {
		if (delay === null) return undefined;
		const timer = setTimeout(() => setTick((n) => n + 1), delay);
		return () => clearTimeout(timer);
	}, [delay, account.snapshot]);
}

export function AccountPageFrame({ heading, children, header }: { heading: string; children: ReactNode; header?: ReactNode }) {
	const insets = useSafeAreaInsets();
	return (
		<View style={[styles.page, { paddingTop: insets.top }]}>
			{header ?? <View style={styles.spacer} />}
			<ScrollView contentContainerStyle={{ paddingHorizontal: space.page, paddingBottom: 32 + insets.bottom }}>
				<Text role="heading" style={styles.heading}>{heading}</Text>
				{children}
			</ScrollView>
		</View>
	);
}

export function Lines({ body, notices }: { body: readonly string[]; notices: readonly Line[] }) {
	return (
		<View style={styles.stack}>
			{body.map((text) => <Text key={text} style={styles.body}>{text}</Text>)}
			{notices.map((notice) => <Notice key={`${notice.title}:${notice.text}`} title={notice.title}>{notice.text}</Notice>)}
		</View>
	);
}

export function Button({ label, onPress, primary = false, disabled = false, reason, testID }: {
	label: string; onPress: () => void; primary?: boolean; disabled?: boolean; reason?: string | null; testID?: string;
}) {
	return (
		<View style={styles.buttonWrap}>
			<Pressable
				testID={testID} role="button" aria-label={label} aria-disabled={disabled} disabled={disabled}
				accessibilityHint={disabled && reason ? reason : undefined}
				onPress={disabled ? undefined : onPress}
				style={[styles.button, primary ? styles.primary : styles.secondary, disabled && styles.disabled]}
			>
				<Text style={[styles.buttonText, primary && styles.primaryText]}>{label}</Text>
			</Pressable>
			{disabled && reason ? <Text style={styles.reason}>{reason}</Text> : null}
		</View>
	);
}

/** Every action on a page. A forbidden action is shown disabled with its reason, never hidden. Sign out asks first. */
export function Actions({ actions, account }: { actions: readonly Action[]; account: Account }) {
	const [confirming, setConfirming] = useState(false);
	return (
		<View style={styles.stack}>
			{actions.map((action) => {
				if (action.kind === 'web') {
					const href = account.webLink(action.path);
					if (href === null) return <Text key={action.id} style={styles.reason}>{copy.webMissing}</Text>;
					return <Button key={action.id} testID={`account-action-${action.id}`} label={action.label} onPress={() => { void Linking.openURL(href); }} />;
				}
				if (action.kind === 'sign-out') {
					if (!confirming) return <Button key="sign-out" testID="account-action-sign-out" label="Sign out" primary={action.primary} onPress={() => setConfirming(true)} />;
					return (
						<View key="sign-out" style={styles.confirm}>
							<Text style={styles.body}>{copy.signOutConfirm}</Text>
							<Button testID="account-action-sign-out-confirm" label="Sign out" primary onPress={() => { setConfirming(false); account.send({ type: 'sign-out' }); }} />
							<Button testID="account-action-sign-out-cancel" label="Keep me signed in" onPress={() => setConfirming(false)} />
						</View>
					);
				}
				return (
					<View key={action.id}>
						<Button
							testID={`account-action-${action.id}`} label={action.label} primary={action.primary}
							disabled={action.disabled !== null} reason={action.disabled} onPress={() => account.send(action.command)}
						/>
						{action.note ? <Text style={styles.reason}>{action.note}</Text> : null}
					</View>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	page: { flex: 1, backgroundColor: colors.page },
	spacer: { minHeight: 52 },
	heading: { fontSize: type.heading, lineHeight: 32, fontWeight: '600', color: colors.heading, marginTop: 4, marginBottom: 14 },
	stack: { gap: 12, marginBottom: 12 },
	body: { fontSize: type.body, lineHeight: 21, color: colors.body },
	buttonWrap: { gap: 4 },
	button: { minHeight: 44, borderRadius: 22, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
	primary: { backgroundColor: colors.body },
	secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
	disabled: { opacity: 0.45 },
	buttonText: { fontSize: type.body, fontWeight: '600', color: colors.body },
	primaryText: { color: colors.card },
	reason: { fontSize: 13, lineHeight: 18, color: colors.muted },
	confirm: { gap: 8, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card }
});
