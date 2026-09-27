import { StatusBar } from 'expo-status-bar';
import { AccountProvider } from '../account/AccountProvider.tsx';
import { AccountStack } from '../account/AccountStack.tsx';
import { accountInstance } from '../account/instance.ts';
import { config, webLink, type WebPath } from '../config.ts';
import { appAccountPlatform } from '../platform/app-account.ts';

/** The app: the account provider over the one composed source, and the account stack that holds every route
 *  (docs/plans/expo-mobile-auth-composition-2026-09.md §4.1). No other routing logic lives here. */
const links = (path: WebPath) => webLink(config.webOrigin, path);

export default function RootLayout() {
	// Created on first render and reused for the life of the process (instance.ts); never composed twice.
	const source = accountInstance(() => appAccountPlatform);
	return (
		<>
			<StatusBar style="dark" />
			<AccountProvider source={source} webLink={links}>
				<AccountStack />
			</AccountProvider>
		</>
	);
}
