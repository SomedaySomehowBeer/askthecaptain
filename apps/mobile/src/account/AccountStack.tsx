import { router, Stack, useNavigationContainerRef, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { colors } from '../theme/tokens.ts';
import { useAccount } from './AccountProvider.tsx';
import { findAccountStack, isReady, isSignedIn, navigationStep, navMount, resetToFreshTabs, tabsKey, type NavMemory } from './copy.ts';
import { captureRequested, consumeRequested, requested, requestedConsumed } from './requested.ts';

/** All root navigation (docs/plans/expo-mobile-auth-composition-2026-09.md §4.1), used unchanged by production's
 *  src/app/_layout.tsx and by the harness layout, so the harness tests this code and nothing is duplicated.
 *
 *  - Guards: `welcome` only when not signed in; `organisation` whenever signed in; the tabs and Account only when ready
 *    (verified identity and a chosen organisation). The refusal page is outside the guards. Losing ready removes the
 *    tabs route and its nested state (the stack router drops a route whose screen is no longer allowed).
 *  - `navigationStep` (copy.ts, pure and node-tested) makes every decision.
 *  - A new person or organisation while ready (a switch, or a loss that auto-chose the one remaining membership) resets
 *    this stack, by its navigator key, to one tabs route with a new key and no nested state: the old tabs, their
 *    per-tab stacks and screens unmount. `router.replace` cannot do this (it navigates inside the existing tabs route,
 *    which keeps its key and state).
 *  - Fail closed: if the stack is ever not found, the tabs are dropped by closing their guard for one commit (the same
 *    route removal as losing ready), then Work opens anew; and the miss is reported with a fixed console error, so the
 *    browser check fails rather than state silently surviving.
 *  - The tab route the app was opened at is captured once, before any guard redirect, and has one chance per process
 *    to be opened (requested.ts): a remount of this stack never opens it again. */
export function AccountStack() {
	const { snapshot, send } = useAccount();
	const account = snapshot.account;
	const pathname = usePathname();
	const container = useNavigationContainerRef();
	const signedIn = isSignedIn(account); const ready = isReady(account);
	const key = tabsKey(account);

	// First render only (later calls change nothing): the web page URL, or the router's first pathname on a phone.
	captureRequested(Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.pathname : pathname);
	// Seeded once per mount: a remount keeps only the requested destination's one-use flag (requested.ts).
	const memory = useRef<NavMemory | null>(null);
	if (memory.current === null) memory.current = navMount(requestedConsumed());
	/** The tabs key whose tabs are being dropped by the guard (the fail-closed path); null normally. */
	const [closedFor, setClosedFor] = useState<string | null>(null);

	useEffect(() => {
		const step = navigationStep(memory.current ?? navMount(requestedConsumed()), account, pathname, requested());
		memory.current = step.memory;
		// The first ready consumes the cold-launch route for the process, whichever destination won.
		if (step.memory.requestedUsed && !requestedConsumed()) consumeRequested();
		const action = step.action;
		if (action.kind === 'reset-tabs') {
			const target = findAccountStack(container.getRootState());
			if (target !== null) { container.dispatch(resetToFreshTabs(target) as never); return; }
			console.error('Captain: the account stack was not found for a tabs reset; closing the tabs instead');
			setClosedFor(key);
		} else if (action.kind === 'destination') {
			router.replace(action.href as never);
			send({ type: 'destination-used' });
		} else if (action.kind === 'open-requested') {
			router.replace(action.href as never);
		} else if (action.kind === 'replace') {
			router.replace(action.href);
		}
	}, [account, key, pathname, send, container]);

	// The fail-closed path's second half: the commit with the guard closed removed the tabs route and its state; reopen
	// the guard and open Work, which builds a new tabs route.
	useEffect(() => {
		if (closedFor === null) return;
		setClosedFor(null);
		router.replace('/work');
	}, [closedFor]);

	return (
		<Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.page } }}>
			<Stack.Protected guard={!signedIn}>
				<Stack.Screen name="welcome" />
			</Stack.Protected>
			<Stack.Protected guard={signedIn}>
				<Stack.Screen name="organisation" />
			</Stack.Protected>
			<Stack.Protected guard={ready && closedFor !== key}>
				<Stack.Screen name="(tabs)" />
				<Stack.Screen name="settings" />
			</Stack.Protected>
			<Stack.Screen name="index" />
			<Stack.Screen name="link-not-allowed" />
		</Stack>
	);
}
