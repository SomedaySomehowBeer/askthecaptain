'use client';
import { useEffect, useState, useTransition } from 'react';
import { registerDevice, removeDevice, sendTest, type Result } from './actions.ts';

type Support = 'checking' | 'unsupported' | 'insecure' | 'denied' | 'ready';
const toBytes = (base64url: string) => { const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replaceAll('-', '+').replaceAll('_', '/'); const raw = atob(padded); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };

/** This device: subscribe, unsubscribe, test. Everything the browser can tell us is said in words
 *  before a button is offered: no push support, not on https, permission denied. */
export function Devices({ publicKey, subscribedEndpoints }: { publicKey: string; subscribedEndpoints: string[] }) {
	const [support, setSupport] = useState<Support>('checking');
	const [endpoint, setEndpoint] = useState<string | null>(null);
	const [result, setResult] = useState<Result | undefined>();
	const [pending, start] = useTransition();
	useEffect(() => {
		if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { setSupport('unsupported'); return; }
		if (!window.isSecureContext) { setSupport('insecure'); return; }
		if (Notification.permission === 'denied') { setSupport('denied'); return; }
		void navigator.serviceWorker.register('/sw.js').then((registration) => registration.pushManager.getSubscription()).then((existing) => { setEndpoint(existing?.endpoint ?? null); setSupport('ready'); }).catch(() => setSupport('unsupported'));
	}, []);
	const thisDeviceSubscribed = endpoint !== null && subscribedEndpoints.includes(endpoint);

	const subscribe = () => start(async () => {
		try {
			const permission = await Notification.requestPermission();
			if (permission !== 'granted') { setSupport('denied'); return; }
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(publicKey) });
			const json = subscription.toJSON();
			if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) { setResult({ error: 'The browser did not give a usable subscription.' }); return; }
			setResult(await registerDevice({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, navigator.userAgent));
			setEndpoint(json.endpoint);
		} catch (error) { setResult({ error: error instanceof Error ? error.message : 'Subscribing failed.' }); }
	});
	const unsubscribe = () => start(async () => {
		const registration = await navigator.serviceWorker.ready; const existing = await registration.pushManager.getSubscription();
		if (existing) { await existing.unsubscribe().catch(() => undefined); setResult(await removeDevice(existing.endpoint)); }
		setEndpoint(null);
	});
	const test = () => start(async () => { setResult(await sendTest()); });

	if (support === 'checking') return <p className="muted">Checking what this browser can do…</p>;
	if (support === 'unsupported') return <p className="secondary">This browser cannot receive pushes. On iPhone, add Captain to the Home Screen from Safari’s share menu, then open it from there.</p>;
	if (support === 'insecure') return <p className="secondary">Pushes need https. Open Captain at its real address.</p>;
	if (support === 'denied') return <p className="secondary">Notifications are blocked for Captain in this browser. Allow them in the browser’s site settings, then reload.</p>;
	return (
		<div className="stack">
			<p className="secondary">{thisDeviceSubscribed ? 'This device receives Captain’s pushes.' : 'This device is not subscribed yet.'}</p>
			<div className="row">
				{thisDeviceSubscribed ? <button className="button button--ghost" type="button" onClick={unsubscribe} disabled={pending}>Stop on this device</button>
					: <button className="button button--primary" type="button" onClick={subscribe} disabled={pending} aria-busy={pending || undefined}>{pending ? 'Working…' : 'Push to this device'}</button>}
				{thisDeviceSubscribed ? <button className="button button--secondary" type="button" onClick={test} disabled={pending}>Send a test</button> : null}
			</div>
			{result?.error ? <p className="form__error" role="alert">{result.error}</p> : result?.message ? <p className="muted" role="status">{result.message}</p> : null}
		</div>
	);
}
