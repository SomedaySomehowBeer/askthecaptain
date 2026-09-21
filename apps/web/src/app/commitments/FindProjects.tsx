'use client';
import { useActionState } from 'react';
import { findProjects } from './discovery-actions.ts';
/** Find projects now: an owner or admin runs discovery on demand (D22). */
export function FindProjects() {
	const [state, submit, pending] = useActionState(findProjects, undefined);
	return <form action={submit} className="stack">
		<div className="row"><button className="button button--secondary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Starting…' : 'Find projects now'}</button>
			<span className="muted">Reads what your mail and notes have gathered since last time and proposes projects for you to accept.</span></div>
		{state?.error ? <p className="form__error" role="alert">{state.error}</p> : state?.message ? <p className="muted" role="status">{state.message}</p> : null}
	</form>;
}
