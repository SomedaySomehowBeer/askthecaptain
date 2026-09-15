import webpush from 'web-push';
import { PushTransportError, type PushTransport } from './service.ts';

/** The production transport: RFC 8291 encryption and VAPID signing by the `web-push` library.
 *  The private key stays in this process; the browser only ever sees the public key. */
export function webPushTransport(keys: { publicKey: string; privateKey: string; subject: string }): PushTransport {
	webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
	return {
		async send(subscription, payload) {
			try { const result = await webpush.sendNotification(subscription, payload, { TTL: 60 * 60 * 12, urgency: 'normal', timeout: 10_000 }); return { statusCode: result.statusCode }; }
			catch (error) {
				const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 0;
				throw new PushTransportError(statusCode, statusCode ? `push service answered ${statusCode}` : 'push service unreachable');
			}
		}
	};
}
