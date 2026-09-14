'use client';
import { useActionState } from 'react';
import type { Organisation } from '../../lib/api.ts';
import { updateOrganisation } from './actions.ts';

export function OrganisationForm({ organisation }: { organisation: Organisation }) {
	const [state, action, pending] = useActionState(updateOrganisation, undefined);
	return (
		<form className="form" action={action}>
			<div className="field"><label htmlFor="org-name">Name</label><input id="org-name" name="name" type="text" defaultValue={organisation.name} required maxLength={120} /></div>
			<div className="field"><label htmlFor="org-tz">Timezone</label><input id="org-tz" name="timezone" type="text" defaultValue={organisation.timezone} maxLength={64} /></div>
			{state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}
			{state?.ok ? <p className="muted" role="status">Saved.</p> : null}
			<div className="row"><button className="button button--secondary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Saving…' : 'Save'}</button></div>
		</form>
	);
}
