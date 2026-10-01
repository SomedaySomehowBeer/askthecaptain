/** Browser APIs only run after an explicit register click. No registration on page load or native. */
import type { PushSubscriptionInput } from '../account/push.ts';
export type PushSupport = 'ready' | 'unsupported' | 'insecure' | 'denied';
export type PushBrowser = { support(): PushSupport; subscribe(key: string, active: () => boolean): Promise<PushSubscriptionInput | null> };
export const browserPush: PushBrowser = {
 support() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return Notification.permission === 'denied' ? 'denied' : 'ready';
 },
 async subscribe(key, active) {
  if (!active()) return null;
  const permission = await Notification.requestPermission();
  if (!active()) return null;
  if (permission !== 'granted') throw new Error('permission');
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  if (!active()) return null;
  // A fresh worker must activate before PushManager.subscribe. Bound the wait; never register twice automatically.
  if (!registration.active) await new Promise<void>((resolve, reject) => {
   const worker = registration.installing ?? registration.waiting;
   const cleanup = () => { clearTimeout(timer); worker?.removeEventListener('statechange', changed); };
   const changed = () => { if (worker?.state === 'activated') { cleanup(); resolve(); } else if (worker?.state === 'redundant') { cleanup(); reject(new Error('worker')); } };
   const timer = setTimeout(() => { cleanup(); reject(new Error('worker timeout')); }, 15000);
   worker?.addEventListener('statechange', changed); changed();
  });
  if (!active()) return null;
  const bytes = Uint8Array.from(atob(key.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - key.length % 4) % 4)), c => c.charCodeAt(0));
  const existing = await registration.pushManager.getSubscription();
  if (!active()) return null;
  const subscription = existing ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  if (!active()) return null;
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('subscription');
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, userAgent: navigator.userAgent.slice(0, 300) };
 }
};
