/** Person-scoped passkey controls. No challenge, assertion or session enters observable state.
 * Writes are never retried; an uncertain write blocks further changes until a successful list refresh.
 * Disposal prevents a late browser ceremony from registering after the person leaves this screen. */
import type { PasskeyList, PasskeyMutation, WebCalls } from './web-calls.ts';
export type PasskeyState = {
 readonly list: PasskeyList | null;
 readonly phase: 'loading' | 'ready' | 'failed' | 'adding' | 'removing';
 readonly message: string;
 readonly mustRefresh: boolean;
 readonly waitUntil: number;
};
export function createPasskeyControls(web: WebCalls, now: () => number) {
 let live = true;
 let state: PasskeyState = { list: null, phase: 'ready', message: '', mustRefresh: true, waitUntil: 0 };
 const listeners = new Set<() => void>();
 const set = (next: PasskeyState) => { if (!live) return; state = Object.freeze(next); for (const fn of listeners) fn(); };
 const busy = () => ['loading', 'adding', 'removing'].includes(state.phase);
 const allowed = () => live && !busy() && now() >= state.waitUntil;
 const refresh = async () => {
  if (!allowed()) return;
  set({ ...state, phase: 'loading' });
  const answer = await web.passkeys();
  if (!live) return;
  if (answer.ok) set({ list: answer.value, phase: 'ready', message: state.mustRefresh ? '' : state.message, mustRefresh: false, waitUntil: 0 });
  else set({ ...state, list: null, phase: 'failed', message: "Couldn't load your passkeys. Try again when the connection is available.", mustRefresh: true, waitUntil: now() + (answer.kind === 'unavailable' ? answer.retryAfter ?? 0 : 0) * 1000 });
 };
 const finish = async (result: PasskeyMutation, action: 'add' | 'remove') => {
  if (!live || result.kind === 'stale') return;
  if (result.kind === 'done') {
   set({ ...state, phase: 'ready', message: action === 'add' ? 'Passkey added. Every sign-in will now ask for a passkey.' : 'Passkey removed.', mustRefresh: false });
   await refresh();
  } else if (result.kind === 'browser') {
   const messages = { dismissed: 'The passkey prompt was dismissed. You can try again.', exists: 'This device already has a passkey for this account.', unsupported: 'This browser could not create a passkey. Try a supported browser at Captain’s HTTPS address.' };
   set({ ...state, phase: 'ready', message: messages[result.reason] });
  } else {
   const message = result.uncertain ? `Couldn't confirm whether the passkey was ${action === 'add' ? 'added' : 'removed'}. Refresh the list before making another change.`
    : result.code === 'challenge_invalid' ? 'Registration expired. Start again to create a fresh challenge.'
    : result.code === 'passkey_invalid' ? 'The passkey could not be verified. Start again.'
    : result.code === 'not_found' ? 'That passkey is no longer available. Refresh the list.'
    : 'Captain could not complete that request. Refresh the list and try again.';
   set({ ...state, phase: 'ready', message, mustRefresh: result.uncertain || result.code === 'not_found', waitUntil: now() + result.retryAfter * 1000 });
  }
 };
 return {
  snapshot: () => state,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  dispose() { live = false; listeners.clear(); },
  refresh,
  async add(name: string, create: (options: unknown) => Promise<unknown>) {
   if (!allowed() || state.mustRefresh || !state.list?.available) return;
   set({ ...state, phase: 'adding', message: '' });
   await finish(await web.addPasskey(name, create, () => live), 'add');
  },
  async remove(id: string) {
   if (!allowed() || state.mustRefresh || !state.list?.available || !state.list.passkeys.some(p => p.id === id)) return;
   set({ ...state, phase: 'removing', message: '' });
   await finish(await web.removePasskey(id), 'remove');
  }
 };
}
