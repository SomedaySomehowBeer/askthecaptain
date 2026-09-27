import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../theme/tokens.ts';

/** The app: the three workspace sections, plus Settings (opened from the avatar, never a fourth tab) and the page
 *  for a link this app will not open. This shell has no sign-in, network or storage yet (contract §9: M-auth follows). */
export default function RootLayout() {
	return (
		<>
			<StatusBar style="dark" />
			<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page } }}>
				<Stack.Screen name="(tabs)" />
				<Stack.Screen name="settings" />
				<Stack.Screen name="link-not-allowed" />
			</Stack>
		</>
	);
}
