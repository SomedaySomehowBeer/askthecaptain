'use client';
import { useActionState } from 'react';
import { requestDiscovery } from '../app/commitments/discovery-actions.ts';
/** Make this a project (D22): a person chooses a thread or note and Captain works out what it is part of. */
export function RequestDiscovery({ kind, id, compact }: { kind: 'mail_thread' | 'note'; id: string; compact?: boolean }) {
	const [state, submit, pending] = useActionState(requestDiscovery, undefined);
	return <form action={submit} className="stack"><input type="hidden" name="kind" value={kind} /><input type="hidden" name="id" value={id} />
		<div className="row"><button className={`button ${compact ? 'button--ghost button--small' : 'button--secondary'}`} type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Asking…' : 'Make this a project'}</button>
			{compact ? null : <span className="muted">Captain gathers what belongs with it and proposes a project, a task or nothing, for you to accept.</span>}</div>
		{state?.error ? <p className="form__error" role="alert">{state.error}</p> : state?.message ? <p className="muted" role="status">{state.message}</p> : null}
	</form>;
}
