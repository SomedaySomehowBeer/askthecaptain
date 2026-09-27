import { StatusBar } from 'expo-status-bar';
import { useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { AccountProvider, useAccount } from '../../src/account/AccountProvider.tsx';
import { AccountStack } from '../../src/account/AccountStack.tsx';
import { config, webLink, type WebPath } from '../../src/config.ts';
import { createScriptedSource, scenarioFrom, transitions, type ScriptedSource } from '../scripted-source.ts';

/** The test-only harness root (docs/plans/expo-mobile-auth-composition-2026-09.md §7.1), bundled only when
 *  CAPTAIN_MOBILE_HARNESS=1 sets the router root to harness/app (web export only). It renders the production
 *  AccountStack inside the production AccountProvider with a scripted source, and adds only:
 *  - the marker, as a testID so minification cannot drop it;
 *  - the command log (`account-command-log`, a JSON array of every command sent);
 *  - a render counter (`account-render-count`) for a component subscribed to the account;
 *  - transition controls (`harness-transition-{lost|lost-single|switch|release|verify}`).
 *  The tabs mount proof (`harness-tabs-mount`) is in harness/app/(tabs)/_layout.tsx.
 *  No routing logic lives here. */
export const harnessMarker = 'CAPTAIN_MOBILE_HARNESS_7f3a';

const links = (path: WebPath) => webLink(config.webOrigin, path);
/** Read once, from the page URL the harness was loaded at; a later route replace that drops the query changes nothing. */
const initialSearch = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.search : '';

/** One scripted source per page (JavaScript process), like production's module-cached `accountInstance`: the router
 *  can remount this root layout (for example when history leads to a route the guards no longer allow), and a remount
 *  must keep the scripted account, its state after transitions and its command log, not start the scenario again. */
let scripted: ScriptedSource | null = null;
const harnessSource = (): ScriptedSource => (scripted ??= createScriptedSource(scenarioFrom(initialSearch)));
/** Renders of the account-subscribed panel for the page's life, so a remount cannot hide renders by starting over. */
let renderCount = 0;

export default function HarnessLayout() {
	const [source] = useState<ScriptedSource>(harnessSource);
	return (
		<>
			<StatusBar style="dark" />
			<AccountProvider source={source} webLink={links}>
				<View style={styles.root}>
					<View style={styles.app}><AccountStack /></View>
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
		</View>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1 },
	app: { flex: 1 },
	panel: { padding: 4, gap: 2, backgroundColor: '#eeeeee' },
	row: { flexDirection: 'row', gap: 8 },
	control: { paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: '#999999' },
	small: { fontSize: 10, color: '#333333' }
});
