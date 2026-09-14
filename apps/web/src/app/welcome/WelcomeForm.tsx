'use client';
import { useActionState } from 'react';
import { createOrganisation } from './actions.ts';

export function WelcomeForm() {
	const [state, action, pending] = useActionState(createOrganisation, undefined);
	return (
		<form className="card form" action={action}>
			<div className="field"><label htmlFor="name">Business name</label><input id="name" name="name" type="text" required maxLength={120} autoFocus /></div>
			<div className="field"><label htmlFor="timezone">Timezone</label>
				<select id="timezone" name="timezone" defaultValue="Australia/Perth">
					{['Australia/Perth', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Brisbane', 'Australia/Sydney', 'Australia/Melbourne', 'Australia/Hobart', 'Pacific/Auckland'].map((zone) => <option key={zone} value={zone}>{zone}</option>)}
				</select></div>
			{state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}
			<button className="button button--primary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Creating…' : 'Create the organisation'}</button>
		</form>
	);
}
