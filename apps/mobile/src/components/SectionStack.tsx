import { Stack } from 'expo-router';
import { Platform } from 'react-native';
import { colors } from '../theme/tokens.ts';

/** A section's own stack. The default view (`index`) is declared first, so it is the stack's first route when nothing
 *  else is asked for. */
export function SectionStack() {
	return (
		<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page } }}>
			<Stack.Screen name="index" />
		</Stack>
	);
}

/** On iOS and Android the view list sits beneath whatever view is open, one page to its left, so the header's back
 *  control and the native back gesture reach it.
 *
 *  On the web every route in a stack must have its own browser-history entry. React Navigation's web linking treats a
 *  shorter stack as going back and calls `history.go(-n)`. A view list placed beneath a view without being navigated
 *  to has no entry, so popping to it would move the browser back into an unrelated entry and then overwrite that entry
 *  (expo-router's fork of useLinking, `historyDelta < 0`). On the web the view list is therefore navigated to, and
 *  gets its entry like any other page. */
export const sectionStackSettings: { initialRouteName?: string } = Platform.OS === 'web' ? {} : { initialRouteName: 'views' };
