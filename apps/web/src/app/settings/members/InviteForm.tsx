'use client';
import { useActionState } from 'react';
import { invite } from '../actions.ts';

export function InviteForm() {
	const [state, action, pending] = useActionState(invite, undefined);
	return (
		<form className="form" action={action}>
			<div className="row">
				<div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="invite-email">Email</label><input id="invite-email" name="email" type="email" required /></div>
				<div className="field"><label htmlFor="invite-role">Role</label><select id="invite-role" name="role" defaultValue="member"><option value="member">member</option><option value="admin">admin</option></select></div>
			</div>
			{state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}
			{state?.inviteLink ? <div className="stack"><p className="secondary" role="status">Send them this link. It is shown once.</p><pre className="codeblock">{state.inviteLink}</pre></div> : null}
			<div className="row"><button className="button button--primary" type="submit" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Inviting…' : 'Create invitation'}</button></div>
		</form>
	);
}
