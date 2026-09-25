'use client';
import { useActionState } from 'react';
import { disconnectGoogle } from './actions.ts';

/** Disconnect only: a deliberate owner/admin action on an existing retired Google grant (#133). */
export function ConnectionActions({ connectionId }: { connectionId: string }) {
	const [disconnected, disconnect, disconnecting] = useActionState(disconnectGoogle, undefined);
	return <div className="stack">
		<form action={disconnect}><input type="hidden" name="connectionId" value={connectionId} />
			<button className="button button--ghost" disabled={disconnecting} aria-busy={disconnecting || undefined} type="submit">{disconnecting ? 'Disconnecting…' : 'Disconnect Google'}</button></form>
		{disconnected?.error ? <p className="form__error" role="alert">{disconnected.error}</p> : null}
	</div>;
}
