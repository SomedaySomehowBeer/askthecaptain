import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import TabsLayout from '../../../src/app/(tabs)/_layout.tsx';

/** The production tabs layout, plus a harness-only mount proof: `harness-tabs-mount` shows which mount of the tabs
 *  subtree this is (1, 2, …) for the page's life. An organisation switch, or a loss that auto-chooses the one remaining
 *  membership, must show a new number (a fresh tabs subtree), not the old one with its tab stacks. No routing logic. */
let mounts = 0;

export default function HarnessTabsLayout() {
	const [mount] = useState(() => { mounts += 1; return mounts; });
	return (
		<View style={styles.fill}>
			<Text testID="harness-tabs-mount" style={styles.proof}>{String(mount)}</Text>
			<TabsLayout />
		</View>
	);
}

const styles = StyleSheet.create({
	fill: { flex: 1 },
	proof: { position: 'absolute', top: 0, right: 0, fontSize: 8, opacity: 0.4, zIndex: 1 }
});
