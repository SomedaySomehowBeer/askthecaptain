'use client';
import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { startTransition, useActionState, useState } from 'react';
import { revokeOtherSessions } from './revoke-actions.ts';
import { checkResult, revokeCopy, revokeResultText, unknownResult, type RevokeResult } from './revoke-result.ts';

/** "Sign out everywhere else" in the Settings "You" card (docs/plans/mobile-session-revocation-2026-09.md §3): one
 *  in-page confirmation (UI, not an approval), then one call. There is no automatic retry, and Cancel sends nothing.
 *
 *  The action call is wrapped so it can never reach an error boundary (installed Next 15.5, server-action-reducer):
 *  - a redirect (the post-send 401) arrives as a rejected promise carrying Next's redirect error, which must be thrown
 *    on for Next to navigate: `unstable_rethrow` does exactly that and nothing else;
 *  - every other rejection (no connection, a deployment mismatch, an unusable response) shows the fixed unknown
 *    wording;
 *  - `undefined` arrives only for a redirect Next completes with a full navigation, so the previous state is kept;
 *  - anything returned is accepted only in an exact allowed shape (`checkResult`). */
export function SignOutEverywhereElse() {
	const [confirming, setConfirming] = useState(false);
	const [result, run, pending] = useActionState<RevokeResult | null, void>(async (previous) => {
		try {
			const value: unknown = await revokeOtherSessions();
			return value === undefined ? previous : checkResult(value);
		} catch (error) {
			unstable_rethrow(error);
			return unknownResult;
		}
	}, null);
	const confirm = () => { setConfirming(false); startTransition(() => run()); };
	return (
		<div className="stack">
			{confirming ? (
				<div className="card notice notice--attention">
					<p className="secondary">{revokeCopy.confirm}</p>
					<div className="row">
						<button className="button button--secondary" type="button" onClick={confirm} disabled={pending}>{revokeCopy.button}</button>
						<button className="button button--ghost" type="button" onClick={() => setConfirming(false)} disabled={pending}>{revokeCopy.cancel}</button>
					</div>
				</div>
			) : (
				<button className="button button--secondary" type="button" onClick={() => setConfirming(true)} disabled={pending} aria-busy={pending || undefined}>
					{pending ? revokeCopy.pending : revokeCopy.button}
				</button>
			)}
			{result !== null && !pending ? (
				<div className="card notice notice--quiet" role="status">
					{revokeResultText(result).map((line) => <p key={line} className="secondary">{line}</p>)}
					{result.kind === 'not-sent' && result.reason === 'signed-out'
						? <Link className="button button--secondary" href="/sign-in?return_to=%2Fsettings">Sign in again</Link> : null}
				</div>
			) : null}
		</div>
	);
}
