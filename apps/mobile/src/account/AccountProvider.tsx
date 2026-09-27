import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';
import type { WebPath } from '../config.ts';
import type { AccountSource } from './account-source.ts';
import type { ScopedRead } from './contracts.ts';
import type { AccountSnapshot } from './machine.ts';
import type { UiCommand } from './runner.ts';

/** The account for screens (docs/plans/expo-mobile-auth-composition-2026-09.md §3). Production passes the one source
 *  from instance.ts; the harness passes a scripted one. Screens get the token-free snapshot, `send`, the clock the
 *  snapshot's waits are measured on, and the allow-listed website links; never a runner, handle or token.
 *
 *  Development rule: after editing anything under src/auth, src/account or src/platform, fully restart the app (reload
 *  the bundle). Fast Refresh keeps the instance built from the old code (instance.ts). */

type Links = (path: WebPath) => string | null;
type Value = { readonly source: AccountSource; readonly webLink: Links };
const AccountContext = createContext<Value | null>(null);

export function AccountProvider({ source, webLink, children }: { source: AccountSource; webLink: Links; children: ReactNode }) {
	// Foreground refresh: the reducer paces it (30 s spacing, the server's wait, coalescing), so repeated transitions
	// cannot bypass it and nothing is timed here.
	useEffect(() => {
		const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') source.send({ type: 'refresh' }); });
		return () => subscription.remove();
	}, [source]);
	const value = useMemo(() => ({ source, webLink }), [source, webLink]);
	return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export type Account = {
	readonly snapshot: AccountSnapshot;
	readonly send: (command: UiCommand) => void;
	readonly now: () => number;
	readonly webLink: Links;
	/** Organisation-scoped reads (docs/plans/expo-mobile-my-work-read-2026-09.md §3.1): token-free, never rejecting.
	 *  Call only from effects and handlers, never during render. */
	readonly read: ScopedRead;
};

export function useAccount(): Account {
	const value = useContext(AccountContext);
	if (value === null) throw new Error('useAccount: no AccountProvider above this screen');
	const { source, webLink } = value;
	// The source's own stable functions, passed directly: `snapshot` returns the same object until the state changes.
	const snapshot = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot);
	return { snapshot, send: source.send, now: source.now, webLink, read: source.read };
}
