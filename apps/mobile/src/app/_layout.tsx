import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
import { AccountProvider } from '../account/AccountProvider.tsx';
import { accountInstance } from '../account/instance.ts';
import { RootStack } from '../account/RootStack.tsx';
import { appAccountPlatform } from '../platform/app-account.ts';
import { webAccountSource } from '../platform/app-web.ts';
import { useCaptainFonts } from '../theme/fonts.ts';

/** The app: the account provider over the one source, and the root stack that holds every route
 *  (docs/plans/expo-web-session-2026-09.md §B.2). On the web the source is the cookie session over the page's own
 *  origin; on iOS and Android the native composition, unchanged. It also loads the type faces. No other routing logic
 *  lives here. */
export default function RootLayout() {
	// The vendored faces (theme/fonts.ts): the web draws at once and swaps them in; iOS and Android wait the moment they take.
	const fonts = useCaptainFonts();
	// Created on first render and reused for the life of the process (instance.ts); never composed twice.
	const source = accountInstance(() => appAccountPlatform, Platform.OS === 'web' ? { create: () => webAccountSource() } : {});
	if (!fonts && Platform.OS !== 'web') return null;
	return (
		<>
			<StatusBar style="auto" />
			<AccountProvider source={source}>
				<RootStack />
			</AccountProvider>
		</>
	);
}
