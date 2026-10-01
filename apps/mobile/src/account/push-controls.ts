import type { ReadScope } from './contracts.ts';
import { deliveryMessage, type PushCalls, type PushData, type PushResult } from './push.ts';
import type { PushBrowser } from '../platform/push-browser.ts';
export type PushState = { phase: 'ready' | 'loading' | 'saving' | 'failed'; data: PushData | null; message: string; needsRefresh: boolean; waitUntil: number };
export function createPushControls(calls: PushCalls, scope: ReadScope, browser: PushBrowser, now: () => number) {
 let live = true, state: PushState = { phase: 'ready', data: null, message: '', needsRefresh: true, waitUntil: 0 };
 const listeners = new Set<() => void>();
 const active = () => live && calls.current(scope);
 const set = (next: PushState) => { if (!active()) return; state = next; for (const fn of listeners) fn(); };
 const allowed = () => active() && !['loading', 'saving'].includes(state.phase) && now() >= state.waitUntil;
 const refresh = async () => {
  if (!allowed()) return;
  set({ ...state, phase: 'loading', data: null });
  const result = await calls.load(scope);
  if (!active() || result.kind === 'stale') return;
  if (result.kind === 'ok') set({ ...state, phase: 'ready', data: result.value, needsRefresh: false, waitUntil: 0, message: state.needsRefresh ? '' : state.message });
  else set({ ...state, phase: 'failed', message: 'Could not load your notification devices. Refresh when the connection is available.', needsRefresh: true, waitUntil: now() + result.retryAfter * 1000 });
 };
 const finish = async (result: PushResult<unknown>, success: string) => {
  if (!active() || result.kind === 'stale') return;
  if (result.kind === 'ok') { set({ ...state, phase: 'ready', message: success, needsRefresh: false }); await refresh(); }
  else set({ ...state, phase: 'ready', needsRefresh: true, waitUntil: now() + result.retryAfter * 1000, message: result.uncertain ? 'Could not confirm that request. It may have completed. Refresh your devices before making another change; no test will be sent again automatically.' : result.code === 'push_unavailable' ? 'Push notifications are not set up on this Captain. Ask an admin to check the configuration.' : result.code === 'no_devices' ? 'No subscribed devices are available. Refresh and register a device.' : 'Captain refused that request. Refresh your account and devices before trying again.' });
 };
 return {
  snapshot: () => state,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  dispose() { live = false; state = { ...state, data: null }; listeners.clear(); },
  refresh,
  async register() {
   if (!allowed() || state.needsRefresh || !state.data?.config.configured || !state.data.config.publicKey || browser.support() !== 'ready') return;
   const key = state.data.config.publicKey;
   set({ ...state, phase: 'saving', message: '' });
   let input;
   try { input = await browser.subscribe(key, active); }
   catch { set({ ...state, phase: 'ready', message: browser.support() === 'denied' ? 'Notifications are blocked. Allow Captain in this browser’s site settings, then refresh.' : 'This browser could not register for notifications. Check permission and the connection, then try again.' }); return; }
   if (!active() || !input) return;
   await finish(await calls.register(scope, input), 'This browser is registered for your account in this organisation.');
  },
  async remove(endpoint: string) {
   if (!allowed() || state.needsRefresh || !state.data?.devices.some(d => d.endpoint === endpoint)) return;
   set({ ...state, phase: 'saving', message: '' });
   // Server removal is organisation/person scoped. Unsubscribing the browser would break its other organisations.
   await finish(await calls.remove(scope, endpoint), 'Device removed from your notifications in this organisation.');
  },
  async test() {
   if (!allowed() || state.needsRefresh || !state.data?.config.configured || !state.data.devices.length) return;
   set({ ...state, phase: 'saving', message: '' });
   const result = await calls.test(scope);
   await finish(result, result.kind === 'ok' ? deliveryMessage(result.value) : '');
  }
 };
}
