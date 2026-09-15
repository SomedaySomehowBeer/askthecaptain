'use client';
import { useActionState } from 'react';
import { connectGoogle, disconnectGoogle } from './actions.ts';

export function ConnectionActions({ connectionId, disabled, unavailable, reconnect = false }: { connectionId?: string; disabled: boolean; unavailable: boolean; reconnect?: boolean }) {
	const [connected, connect, connecting] = useActionState(connectGoogle, undefined);
	const [disconnected, disconnect, disconnecting] = useActionState(disconnectGoogle, undefined);
	const pending = connecting || disconnecting;
	return <div className="stack">
		<div className="row">
			<form action={connect}><button className="button" disabled={disabled || unavailable || pending} aria-busy={connecting || undefined} type="submit">{connecting ? 'Opening Google…' : reconnect ? 'Reconnect Google' : 'Connect Google'}</button></form>
			{connectionId ? <form action={disconnect}><input type="hidden" name="connectionId" value={connectionId} /><button className="button button--ghost" disabled={disabled || pending} aria-busy={disconnecting || undefined} type="submit">{disconnecting ? 'Disconnecting…' : 'Disconnect'}</button></form> : null}
		</div>
		{connected?.error || disconnected?.error ? <p className="form__error" role="alert">{connected?.error || disconnected?.error}</p> : null}
	</div>;
}
