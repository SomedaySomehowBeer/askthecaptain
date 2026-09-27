import { requestedDestination } from './copy.ts';

/** The tab route the app was opened at (docs/plans/expo-mobile-auth-composition-2026-09.md §4.7), captured once per
 *  process before any guard redirect, and only if it is a linkable tab route. It is used as the sign-in `returnTo`, and
 *  opened once when a restored saved session first becomes ready (copy.ts `navigationStep`).
 *
 *  The first capture wins; later calls change nothing. On the web the page URL is read at the first capture; on iOS and
 *  Android `AccountStack` passes the router's first pathname, which comes from the link already checked by
 *  +native-intent. Record links are not carried in this increment.
 *
 *  Its one chance to be opened is also per process: the first time the account is ready consumes it, whether it was
 *  opened or a sign-in's own destination won. `AccountStack` seeds its navigation memory from `requestedConsumed()`, so
 *  a remount of the stack (the router can remount the root layout) never opens it a second time. Nothing else about
 *  navigation is kept across mounts. */
let captured: string | null | undefined;
let consumed = false;

export function captureRequested(pathname: string | null): void {
	if (captured === undefined) captured = requestedDestination(pathname);
}

export const requested = (): string | null => captured ?? null;

/** Whether the first ready has already happened in this process. */
export const requestedConsumed = (): boolean => consumed;
export function consumeRequested(): void { consumed = true; }

/** Tests only. */
export function resetRequestedForTests(): void { captured = undefined; consumed = false; }
