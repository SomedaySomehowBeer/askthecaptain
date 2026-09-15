'use client';
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { useEffect, useState, useTransition } from 'react';
import { stepUpOptions, stepUpVerify } from './actions.ts';

/** Asks the browser for the passkey and hands the assertion back. Starts on its own once, and offers
 *  a button to try again; every failure is said in words with the way out (start sign-in again). */
export function StepUp({ token }: { token: string }) {
	const [state, setState] = useState<'starting' | 'waiting' | 'checking' | 'failed'>('starting');
	const [message, setMessage] = useState<string>('');
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
		if (result?.error) { setState('failed'); setMessage(result.error); }
	});
	useEffect(() => { if (state === 'starting') attempt(); // eslint-disable-line react-hooks/exhaustive-deps
	}, []);
	return (
		<div className="stack">
			{state === 'waiting' ? <p className="secondary">Your browser is asking for your passkey.</p> : state === 'checking' ? <p className="secondary">Checking…</p> : null}
			{state === 'failed' ? <p className="form__error" role="alert">{message}</p> : null}
			<div className="row">
				<button className="button button--primary" type="button" onClick={attempt} disabled={pending || state === 'checking'}>{state === 'failed' ? 'Try again' : 'Use my passkey'}</button>
				<a className="button button--ghost" href="/sign-in">Start over</a>
			</div>
		</div>
	);
}
