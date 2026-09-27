import { Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { sections } from '../navigation/sections.ts';
import { colors, tabBar, tabBarWidth } from '../theme/tokens.ts';
import { SectionIcon } from './Icons.tsx';

/** The subset of the tab navigator's bar props this bar uses. */
type TabRoute = { key: string; name: string; state?: unknown };
export type TabBarProps = {
	state: { index: number; routes: TabRoute[] };
	navigation: {
		emit(event: { type: 'tabPress'; target: string; canPreventDefault: true }): { defaultPrevented: boolean };
		navigate(name: string, params?: object): void;
	};
};

/** Accessibility uses React Native's `role` and `aria-*` props, which iOS, Android and React Native Web all map;
 *  React Native Web 0.21 ignores `accessibilityState`.
 *
 *  The floating capsule tab bar (mockup navigation.css): Work, Chat and Resources, labels always visible, the
 *  selected tab in a darker grey-green pill at 50% with a green icon and label. Account and Settings are not here;
 *  they open from the header's avatar.
 *
 *  Each tab keeps its own stack. Choosing another tab returns to where that tab was left. The first visit opens the
 *  tab's default view with its view list one page to the left. Pressing the tab already shown does nothing, so it
 *  never discards the current view. */
export function TabBar({ state, navigation }: TabBarProps) {
	const insets = useSafeAreaInsets(); const { width } = useWindowDimensions();
	const barWidth = tabBarWidth(width);
	return (
		<View pointerEvents="box-none" style={[styles.wrap, { bottom: tabBar.bottom + insets.bottom }]}>
			<View role="tablist" style={[styles.bar, { width: barWidth }]}>
				{state.routes.map((route, index) => {
					const section = sections.find((s) => s.key === route.name);
					if (!section) return null;
					const selected = state.index === index; const tint = selected ? colors.selectedText : colors.barText;
					const onPress = () => {
						const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
						if (selected || event.defaultPrevented) return;
						// A tab never visited opens its default view: on iOS and Android with the view list beneath it; on the web
						// alone, because there every route needs its own history entry (see sectionStackSettings). A visited tab is
						// restored as left.
						if (route.state === undefined) navigation.navigate(route.name, Platform.OS === 'web' ? { screen: 'index' } : { screen: 'index', initial: false });
						else navigation.navigate(route.name);
					};
					return (
						<Pressable key={route.key} onPress={onPress} role="tab" aria-label={section.label}
							aria-selected={selected} style={[styles.tab, selected ? styles.selected : null]}>
							<SectionIcon name={section.key} color={tint} />
							<Text style={[styles.label, { color: tint }]} maxFontSizeMultiplier={1.4}>{section.label}</Text>
						</Pressable>
					);
				})}
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
	bar: {
		minHeight: tabBar.height, padding: tabBar.padding, borderRadius: tabBar.radius, flexDirection: 'row', gap: 1,
		backgroundColor: colors.barBackground, borderWidth: 1, borderColor: colors.barBorder,
		shadowColor: colors.barShadow, shadowOpacity: 0.1, shadowRadius: 13, shadowOffset: { width: 0, height: 8 }, elevation: 6
	},
	tab: { flex: 1, minWidth: tabBar.minTarget, minHeight: tabBar.minTarget, borderRadius: tabBar.radius, alignItems: 'center', justifyContent: 'center', gap: 1 },
	selected: { backgroundColor: colors.selectedPill },
	label: { fontSize: tabBar.label, fontWeight: tabBar.labelWeight }
});
