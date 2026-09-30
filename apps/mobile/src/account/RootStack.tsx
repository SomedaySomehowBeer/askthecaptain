import { router, Stack, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { linkableRoutes } from '../lib/links.ts';
import { colors } from '../theme/tokens.ts';
import { useAccount } from './AccountProvider.tsx';
import { isReady, isSignedIn } from './copy.ts';

/** All root navigation (docs/plans/expo-web-session-2026-09.md §B.2): one stack, no tabs, used unchanged by
 *  production's src/app/_layout.tsx and by the harness layout, so the harness tests this code.
 *
 *  - Guards: `welcome` only when not signed in; `organisation` whenever signed in; the thread list, settings and the
 *    equipment schedule while signed in or still checking (so a page opened directly stays open while `/v1/me` is
 *    out, and shows the check in words). The step-up, invitation and refusal pages are outside the guards. Losing a
 *    guard drops the route: the router then shows the index, which redirects to where the account allows.
 *  - A new person or organisation while ready (a switch, a loss that auto-chose the one remaining membership), or
 *    becoming ready from the chooser, goes to the thread list, popping every screen above it so nothing bound to the
 *    old scope survives.
 *  - A native sign-in destination (a verified `return_to`) is opened once, then reported used. */
export function RootStack() {
	const { snapshot, send } = useAccount();
	const account = snapshot.account;
	const pathname = usePathname();
	const signedIn = isSignedIn(account); const ready = isReady(account);
	const checking = account.kind === 'checking' || account.kind === 'starting';
	const key = signedIn && account.org.kind === 'chosen' ? `${account.user.id}:${account.org.membership.organisationId}` : null;

	const previous = useRef<{ key: string | null; ready: boolean }>({ key, ready });
	useEffect(() => {
		const was = previous.current; previous.current = { key, ready };
		if (!ready) return;
		if ((was.key !== null && key !== was.key) || (!was.ready && pathname === '/organisation')) router.dismissTo('/');
	}, [key, ready, pathname]);

	const destination = signedIn && ready ? account.destination : null;
	useEffect(() => {
		if (destination === null) return;
		send({ type: 'destination-used' });
		if (linkableRoutes.has(destination) && destination !== pathname) router.replace(destination as never);
	}, [destination, pathname, send]);

	return (
		<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page } }}>
			<Stack.Screen name="index" />
			<Stack.Protected guard={!signedIn}>
				<Stack.Screen name="welcome" />
			</Stack.Protected>
			<Stack.Protected guard={signedIn}>
				<Stack.Screen name="organisation" />
			</Stack.Protected>
			<Stack.Protected guard={signedIn || checking}>
				<Stack.Screen name="settings" />
				<Stack.Screen name="equipment" />
			</Stack.Protected>
			<Stack.Screen name="auth/passkey" />
			<Stack.Screen name="invitations/accept" />
			<Stack.Screen name="link-not-allowed" />
		</Stack>
	);
}
