'use client';
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useEffect, useState, useTransition } from 'react';
import { registerPasskey, registrationOptions } from './actions.ts';

/** Registers this device's passkey: the API's options, the browser's ceremony, the API's check. */
export function AddPasskey() {
	const [supported, setSupported] = useState<boolean | null>(null);
	const [name, setName] = useState('');
	const [message, setMessage] = useState<{ error?: string; ok?: boolean }>({});
	const [pending, start] = useTransition();
	useEffect(() => { setSupported(typeof window !== 'undefined' && 'PublicKeyCredential' in window && window.isSecureContext); }, []);
	const add = () => start(async () => {
		setMessage({});
		const got = await registrationOptions();
		if (!got.token || !got.options) { setMessage({ error: got.error ?? 'Could not start.' }); return; }
		let response: unknown;
		try { response = await startRegistration({ optionsJSON: got.options as PublicKeyCredentialCreationOptionsJSON }); }
		catch (error) { setMessage({ error: error instanceof Error && error.name === 'InvalidStateError' ? 'This device already has a passkey for this account.' : error instanceof Error && error.name === 'NotAllowedError' ? 'The passkey prompt was dismissed.' : 'This browser could not create a passkey.' }); return; }
		const result = await registerPasskey(got.token, name, response);
		setMessage(result.error ? { error: result.error } : { ok: true }); if (!result.error) setName('');
	});
	if (supported === null) return <p className="muted">Checking what this browser can do…</p>;
	if (!supported) return <p className="secondary">This browser cannot create passkeys, or Captain is not open at its https address.</p>;
	return (
		<div className="form">
			<div className="row">
				<div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="passkey-name">A name for this device (optional)</label><input id="passkey-name" type="text" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ryan’s phone" /></div>
			</div>
			{message.error ? <p className="form__error" role="alert">{message.error}</p> : message.ok ? <p className="muted" role="status">Added. From now on, sign-in asks for a passkey.</p> : null}
			<div className="row"><button className="button button--primary" type="button" onClick={add} disabled={pending} aria-busy={pending || undefined}>{pending ? 'Working…' : 'Add a passkey for this device'}</button></div>
		</div>
	);
}
