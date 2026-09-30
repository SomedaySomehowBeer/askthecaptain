import { StatusBar } from 'expo-status-bar';
import { useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { AccountProvider, useAccount } from '../../src/account/AccountProvider.tsx';
import { RootStack } from '../../src/account/RootStack.tsx';
import { createWebCalls } from '../../src/account/web-calls.ts';
import { createApiClient, createTransport } from '../../src/api/client.ts';
import { webSend } from '../../src/platform/fetch.ts';
import { pageOrigin } from '../../src/platform/app-web.ts';
import { createScriptedSource, revocationControls, scenarioFrom, transitions, type ScriptedSource } from '../scripted-source.ts';
import { readControls } from '../work-fixtures.ts';

/** The test-only harness root (docs/plans/expo-mobile-auth-composition-2026-09.md §7.1), bundled only when
 *  CAPTAIN_MOBILE_HARNESS=1 sets the router root to harness/app (web export only). It renders the production
 *  RootStack inside the production AccountProvider with a scripted source, and adds only:
 *  - the marker, as a testID so minification cannot drop it;
 *  - the command log (`account-command-log`, a JSON array of every command sent);
 *  - a render counter (`account-render-count`) for a component subscribed to the account;
 *  - transition controls (`harness-transition-{lost|lost-single|switch|release|verify}`).
 *  A web scenario's web calls (the step-up, passkeys, an invitation) go through the production web transport to the
 *  harness page's own origin, so the browser check answers them as the API would; nothing else leaves the page.
 *  No routing logic lives here. */
export const harnessMarker = 'CAPTAIN_MOBILE_HARNESS_7f3a';

/** Read once, from the page URL the harness was loaded at; a later route replace that drops the query changes nothing. */
const initialSearch = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.search : '';

/** One scripted source per page (JavaScript process), like production's module-cached `accountInstance`: the router
 *  can remount this root layout (for example when history leads to a route the guards no longer allow), and a remount
 *  must keep the scripted account, its state after transitions and its command log, not start the scenario again. */
let scripted: ScriptedSource | null = null;
const harnessSource = (): ScriptedSource => (scripted ??= createScriptedSource(scenarioFrom(initialSearch), {
	webCalls: (hooks) => {
		const origin = pageOrigin(typeof window === 'undefined' ? undefined : window.location) ?? 'https://harness.invalid';
		return createWebCalls(createApiClient(createTransport({ origin, send: webSend })), origin, hooks);
	}
}));
/** Renders of the account-subscribed panel for the page's life, so a remount cannot hide renders by starting over. */
let renderCount = 0;

export default function HarnessLayout() {
	const [source] = useState<ScriptedSource>(harnessSource);
	return (
		<>
			<StatusBar style="dark" />
			<AccountProvider source={source}>
				<View style={styles.root}>
					<View style={styles.app}><RootStack /></View>
					<HarnessPanel source={source} />
				</View>
			</AccountProvider>
		</>
	);
}

function HarnessPanel({ source }: { source: ScriptedSource }) {
	// Subscribed to the account like any screen, so a render loop would show here as a climbing count.
	useAccount();
	renderCount += 1;
	const log = useSyncExternalStore(source.subscribeLog, source.log, source.log);
	return (
		<View testID={harnessMarker} style={styles.panel}>
			<Text testID="harness-scenario" style={styles.small}>{source.scenario}</Text>
			<Text testID="account-render-count" style={styles.small}>{String(renderCount)}</Text>
			<Text testID="account-command-log" style={styles.small}>{JSON.stringify(log)}</Text>
			<View style={styles.row}>
				{transitions.map((to) => (
					<Pressable key={to} testID={`harness-transition-${to}`} role="button" onPress={() => source.transition(to)} style={styles.control}>
						<Text style={styles.small}>{to}</Text>
					</Pressable>
				))}
			</View>
			{/* Inside the marker panel, so the browser's no-digits check strips it with the rest of the harness text. */}
			<ReadPanel source={source} />
			<RevocationPanel source={source} />
		</View>
	);
}

/** Sign out everywhere else (docs/plans/mobile-session-revocation-2026-09.md §5, increment 3), kept apart from the
 *  command log:
 *  - `account-revoke-log`: a JSON array of the person epoch each request was sent for, oldest first;
 *  - `account-revoke-pending`: `true` while one is pending;
 *  - `harness-revoke-{control}`: answers the pending request (see scripted-source.ts `revocationControls`). An answer
 *    after the person changed changes nothing, as in the runner. */
function RevocationPanel({ source }: { source: ScriptedSource }) {
	const sent = useSyncExternalStore(source.subscribeRevocations, source.revocations, source.revocations);
	return (
		<View style={styles.reads}>
			<Text testID="account-revoke-log" numberOfLines={1} style={styles.small}>{JSON.stringify(sent.log)}</Text>
			<Text testID="account-revoke-pending" style={styles.small}>{String(sent.pending)}</Text>
			<View style={styles.wrap}>
				{revocationControls.map((control) => (
					<Pressable key={control} testID={`harness-revoke-${control}`} role="button" onPress={() => source.resolveRevocation(control)} style={styles.control}>
						<Text style={styles.small}>{control}</Text>
					</Pressable>
				))}
			</View>
		</View>
	);
}

/** Reads (docs/plans/expo-mobile-my-work-read-2026-09.md §3.7), kept apart from the send-only command log and from the
 *  account render counter:
 *  - `work-read-log`: a JSON array of every read sent, `{ id, path, epoch }`, oldest first. Shown as one line, so many
 *    reads don't crowd the screen; its text content is always complete.
 *  - `work-read-pending`: a JSON array of the IDs still pending, oldest first.
 *  - `harness-read-{control}`: resolves the **oldest** pending read (see work-fixtures.ts for each control's answer). A
 *    read whose scope changed before it is resolved answers `superseded`, as in the runner. */
function ReadPanel({ source }: { source: ScriptedSource }) {
	const reads = useSyncExternalStore(source.subscribeReads, source.reads, source.reads);
	return (
		<View style={styles.reads}>
			<Text testID="work-read-log" numberOfLines={1} style={styles.small}>{JSON.stringify(reads.log)}</Text>
			<Text testID="work-read-pending" numberOfLines={1} style={styles.small}>{JSON.stringify(reads.pending)}</Text>
			<View style={styles.wrap}>
				{readControls.map((control) => (
					<Pressable key={control} testID={`harness-read-${control}`} role="button" onPress={() => source.resolveRead(control)} style={styles.control}>
						<Text style={styles.small}>{control}</Text>
					</Pressable>
				))}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
	reads: { gap: 2 },
	root: { flex: 1 },
	app: { flex: 1 },
	panel: { padding: 4, gap: 2, backgroundColor: '#eeeeee' },
	row: { flexDirection: 'row', gap: 8 },
	control: { paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: '#999999' },
	small: { fontSize: 10, color: '#333333' }
});
