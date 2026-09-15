'use client';
import { useActionState } from 'react';
import { deleteOrganisation } from './actions.ts';

export function DeleteForm({ name }: { name: string }) {
	const [state, action, pending] = useActionState(deleteOrganisation, undefined);
	return (
		<form className="form" action={action}>
			<div className="field"><label htmlFor="delete-name">Type the organisation’s name, {name}, to confirm</label><input id="delete-name" name="name" type="text" autoComplete="off" required /></div>
			{state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}
			<div className="row"><button className="button button--danger" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Deleting…' : 'Delete this organisation for good'}</button></div>
		</form>
	);
}
