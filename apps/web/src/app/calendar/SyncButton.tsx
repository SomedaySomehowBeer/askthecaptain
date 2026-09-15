'use client';
import { useActionState } from 'react';
import { syncCalendar } from './actions.ts';
export function SyncButton({ disabled }: { disabled: boolean }) {
	const [state, action, pending] = useActionState(syncCalendar, undefined);
	return <form action={action} className="stack">
		<div><button type="submit" className="button button--secondary" disabled={disabled || pending} aria-busy={pending || undefined}>{pending ? 'Syncing calendar…' : 'Sync now'}</button></div>
		{state?.error ? <p role="alert" className="form__error">{state.error}</p> : state?.ok ? <p role="status" className="muted">Calendar sync finished.</p> : null}
	</form>;
}
