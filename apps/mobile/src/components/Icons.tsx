import { StyleSheet, View } from 'react-native';
import type { SectionKey } from '../navigation/sections.ts';

/** Rounded briefcase, conversation bubble and folder (mockup README "Visual direction"), drawn with plain views so no
 *  icon or SVG dependency is needed. Each is a 22 × 22 box; `color` is the stroke. Decorative: the tab label names it,
 *  so each is `aria-hidden`, which React Native maps on iOS, Android and the web. */
export function SectionIcon({ name, color, size = 22 }: { name: SectionKey; color: string; size?: number }) {
	const s = size / 22; const stroke = Math.max(1.5, 1.65 * s);
	const box = { width: size, height: size };
	if (name === 'work') return (
		<View style={box} aria-hidden>
			<View style={{ position: 'absolute', left: 7 * s, top: 3 * s, width: 8 * s, height: 5 * s, borderWidth: stroke, borderBottomWidth: 0, borderColor: color, borderTopLeftRadius: 2.5 * s, borderTopRightRadius: 2.5 * s }} />
			<View style={{ position: 'absolute', left: 2 * s, top: 7 * s, width: 18 * s, height: 12 * s, borderWidth: stroke, borderColor: color, borderRadius: 3.5 * s }} />
			<View style={{ position: 'absolute', left: 2 * s, top: 12 * s, width: 18 * s, height: stroke, backgroundColor: color }} />
		</View>
	);
	if (name === 'chat') return (
		<View style={box} aria-hidden>
			<View style={{ position: 'absolute', left: 2 * s, top: 3 * s, width: 18 * s, height: 13 * s, borderWidth: stroke, borderColor: color, borderRadius: 6 * s }} />
			<View style={{ position: 'absolute', left: 5.5 * s, top: 14.5 * s, width: 5 * s, height: 5 * s, borderLeftWidth: stroke, borderBottomWidth: stroke, borderColor: color, borderBottomLeftRadius: 1.5 * s, transform: [{ skewY: '-35deg' }] }} />
		</View>
	);
	return (
		<View style={box} aria-hidden>
			<View style={{ position: 'absolute', left: 2 * s, top: 4 * s, width: 8 * s, height: 4 * s, borderWidth: stroke, borderBottomWidth: 0, borderColor: color, borderTopLeftRadius: 2 * s, borderTopRightRadius: 2 * s }} />
			<View style={{ position: 'absolute', left: 2 * s, top: 7 * s, width: 18 * s, height: 12 * s, borderWidth: stroke, borderColor: color, borderRadius: 3 * s, borderTopLeftRadius: 0 }} />
		</View>
	);
}

/** A small left chevron for the header's way back to the view list. */
export function Chevron({ color }: { color: string }) {
	return <View aria-hidden style={[styles.chevron, { borderColor: color }]} />;
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

const styles = StyleSheet.create({
	chevron: { width: 10, height: 10, borderLeftWidth: 2, borderBottomWidth: 2, transform: [{ rotate: '45deg' }], marginLeft: 4, marginRight: 2 },
	icon18: { width: 18, height: 18 }
});
