'use client';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { useEffect, useState, useTransition } from 'react';
import { stepUpOptions, stepUpVerify } from './actions.ts';

/** Asks the browser for the passkey and hands the assertion back. Starts on its own once, and offers
 *  a button to try again; every failure is said in words with the way out (start sign-in again). For a
 *  mobile app's sign-in (`native`), a verified passkey hands a one-time code back to the app; starting over
 *  happens in the app, not on this site. */
export function StepUp({ token, native = false }: { token: string; native?: boolean }) {
	const [state, setState] = useState<'starting' | 'waiting' | 'checking' | 'returning' | 'failed'>('starting');
	const [message, setMessage] = useState<string>('');
	const [target, setTarget] = useState<string | null>(null);
	const [pending, start] = useTransition();
	const attempt = () => start(async () => {
		setState('waiting'); setMessage('');
		const got = await stepUpOptions(token);
		if (!got.options) { setState('failed'); setMessage(got.error ?? 'The sign-in could not continue.'); return; }
		let response: unknown;
		try { response = await startAuthentication({ optionsJSON: got.options as PublicKeyCredentialRequestOptionsJSON }); }
		catch (error) { setState('failed'); setMessage(error instanceof Error && error.name === 'NotAllowedError' ? 'The passkey prompt was dismissed.' : 'This browser could not use a passkey.'); return; }
		setState('checking');
		const result = await stepUpVerify(token, response);
		if (result?.nativeTarget) { setTarget(result.nativeTarget); setState('returning'); window.location.assign(result.nativeTarget); return; }
		if (result?.error) { setState('failed'); setMessage(result.error); }
	});
	useEffect(() => { if (state === 'starting') attempt(); // eslint-disable-line react-hooks/exhaustive-deps
	}, []);
	if (state === 'returning') return (
		<div className="stack" role="status">
			<p className="secondary">Your passkey is confirmed. Returning to the Captain app…</p>
			{target ? <p className="muted">If the app does not open, <a href={target}>return to the app</a>.</p> : null}
		</div>
	);
	return (
		<div className="stack">
			{state === 'waiting' ? <p className="secondary">Your browser is asking for your passkey.</p> : state === 'checking' ? <p className="secondary">Checking…</p> : null}
			{state === 'failed' ? <p className="form__error" role="alert">{message}{native ? ' Close this window and start again from the app.' : ''}</p> : null}
			<div className="row">
				<button className="button button--primary" type="button" onClick={attempt} disabled={pending || state === 'checking'}>{state === 'failed' ? 'Try again' : 'Use my passkey'}</button>
				{native ? null : <a className="button button--ghost" href="/sign-in">Start over</a>}
			</div>
		</div>
	);
}
