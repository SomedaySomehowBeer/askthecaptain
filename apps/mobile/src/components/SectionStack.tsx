import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { colors } from '../theme/tokens.ts';

/** On iOS and Android the view list is the section stack's initial route, so it sits beneath the open view, one page to
 *  its left, and the header's back control and the native back gesture reach it (docs/plans/expo-mobile-native-
 *  navigation-2026-09.md). The same value is each section layout's `unstable_settings` (the linking anchor) and the
 *  navigator's own `initialRouteName`, so the two cannot drift apart.
 *
 *  On the web every route in a stack must have its own browser-history entry. React Navigation's web linking treats a
 *  shorter stack as going back and calls `history.go(-n)`. A view list placed beneath a view without being navigated
 *  to has no entry, so popping to it would move the browser back into an unrelated entry and then overwrite that entry
 *  (expo-router's fork of useLinking, `historyDelta < 0`). On the web the view list is therefore navigated to, and
 *  gets its entry like any other page. */
export const sectionStackSettings: { initialRouteName?: string } = Platform.OS === 'web' ? {} : { initialRouteName: 'views' };

/** Whether section stacks are anchored at their view list (iOS and Android). Every app-initiated tab entry, the tab
 *  bar's first visit and the tabs reset take their shape from this (copy.ts `tabEntryAction`, `firstVisitParams`,
 *  `resetToFreshTabs`). */
export const anchored = sectionStackSettings.initialRouteName !== undefined;

/** A section's own stack. `index` (the default view) is declared first, so it stays `routeNames[0]` on every platform;
 *  `views` is declared too, so the initial route is always one of the navigator's screens.
 *
 *  With the view list as the initial route, a section stack built with no target would open at the view list alone.
 *  No entry does that: every one names its target (`initial: false`, `withAnchor`, or the seeded reset). */
export function SectionStack() {
	return (
		<Stack initialRouteName={sectionStackSettings.initialRouteName} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page } }}>
			<Stack.Screen name="index" />
			<Stack.Screen name="views" />
		</Stack>
	);
}
