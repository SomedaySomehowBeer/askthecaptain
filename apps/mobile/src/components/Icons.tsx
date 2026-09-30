import { StyleSheet, View } from 'react-native';

/** Small icons drawn with plain views, so no icon or SVG dependency is needed. Decorative: each is `aria-hidden`,
 *  which React Native maps on iOS, Android and the web; the control's label names it. */

/** A small left chevron for a header's way back. */
export function Chevron({ color }: { color: string }) {
	return <View aria-hidden style={[styles.chevron, { borderColor: color }]} />;
}

/** A right chevron for a row that opens something. */
export function ChevronRight({ color }: { color: string }) {
	return <View aria-hidden style={[styles.chevronRight, { borderColor: color }]} />;
}

/** A magnifier for the header's search control. */
export function Magnifier({ color }: { color: string }) {
	return (
		<View style={styles.icon18} aria-hidden>
			<View style={{ position: 'absolute', left: 2, top: 2, width: 11, height: 11, borderRadius: 6, borderWidth: 1.8, borderColor: color }} />
			<View style={{ position: 'absolute', left: 12, top: 11, width: 1.8, height: 6, backgroundColor: color, borderRadius: 1, transform: [{ rotate: '-45deg' }] }} />
		</View>
	);
}

/** A calendar for the equipment schedule's pinned row. */
export function Calendar({ color }: { color: string }) {
	return (
		<View style={styles.icon18} aria-hidden>
			<View style={{ position: 'absolute', left: 1, top: 3, width: 16, height: 14, borderRadius: 3, borderWidth: 1.6, borderColor: color }} />
			<View style={{ position: 'absolute', left: 1, top: 7, width: 16, height: 1.6, backgroundColor: color }} />
			<View style={{ position: 'absolute', left: 5, top: 1, width: 1.6, height: 4, backgroundColor: color }} />
			<View style={{ position: 'absolute', left: 11.4, top: 1, width: 1.6, height: 4, backgroundColor: color }} />
		</View>
	);
}

/** Two heads for the team's pinned row. */
export function People({ color }: { color: string }) {
	return (
		<View style={styles.icon18} aria-hidden>
			<View style={{ position: 'absolute', left: 3, top: 2, width: 6, height: 6, borderRadius: 3, borderWidth: 1.6, borderColor: color }} />
			<View style={{ position: 'absolute', left: 0, top: 9, width: 12, height: 7, borderTopLeftRadius: 6, borderTopRightRadius: 6, borderWidth: 1.6, borderBottomWidth: 0, borderColor: color }} />
			<View style={{ position: 'absolute', left: 11, top: 3, width: 5, height: 5, borderRadius: 2.5, borderWidth: 1.6, borderColor: color }} />
			<View style={{ position: 'absolute', left: 12, top: 10, width: 6, height: 6, borderTopLeftRadius: 2, borderTopRightRadius: 6, borderWidth: 1.6, borderBottomWidth: 0, borderLeftWidth: 0, borderColor: color }} />
		</View>
	);
}

const styles = StyleSheet.create({
	chevron: { width: 10, height: 10, borderLeftWidth: 2, borderBottomWidth: 2, transform: [{ rotate: '45deg' }], marginLeft: 4, marginRight: 2 },
	chevronRight: { width: 9, height: 9, borderRightWidth: 2, borderTopWidth: 2, transform: [{ rotate: '45deg' }], marginRight: 4 },
	icon18: { width: 18, height: 18 }
});
