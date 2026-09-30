import { memberChangeAllowed, type MemberAction, type MemberScope, type MembersCalls, type MembersData, type InvitationLink } from './members.ts';
export type MemberState = {
 readonly phase: 'idle' | 'loading' | 'ready' | 'saving' | 'failed' | 'refused';
 readonly data: MembersData | null;
 readonly message: string;
 readonly invitation: InvitationLink | null;
 readonly waitUntil: number;
 readonly needsRefresh: boolean;
};
const refusals: Record<string, string> = {
 last_owner: 'An organisation needs at least one owner. Make another person an owner first.',
 membership_changed: 'That membership changed while this was being saved. Refresh and review it before trying again.',
 already_member: 'That person is already a member.',
 email_invalid: 'Enter a valid email address.',
 invalid_request: 'Captain could not use those details. Check them and try again.',
 forbidden: 'You no longer have permission for that change. Refresh your account and organisation.',
 not_found: 'That member or invitation is no longer available. Refresh the list.'
};
/** All writes require a current full list. Unknown outcomes reconcile through reads, never replay writes.
 * Invitation links live only in this screen's memory and clear on scope disposal or a later mutation. */
export function createMemberControls(calls: MembersCalls, scope: MemberScope, now: () => number) {
 let live = true;
 let state: MemberState = { phase: 'idle', data: null, message: '', invitation: null, waitUntil: 0, needsRefresh: true };
 const listeners = new Set<() => void>();
 const set = (next: MemberState) => { if (!live) return; state = Object.freeze(next); for (const fn of listeners) fn(); };
 const idle = () => live && state.phase !== 'loading' && state.phase !== 'saving' && now() >= state.waitUntil;
 const refresh = async () => {
  if (!idle()) return;
  set({ ...state, phase: 'loading', data: null });
  const result = await calls.load(scope);
  if (!live || result.kind === 'stale') return;
  if (result.kind === 'ok') set({ ...state, phase: 'ready', data: result.value, message: state.needsRefresh ? '' : state.message, needsRefresh: false, waitUntil: 0, invitation: state.invitation && result.value.invitations.some(row => row.id === state.invitation?.id) ? state.invitation : null });
  else set({ ...state, phase: result.kind === 'refused' ? 'refused' : 'failed', invitation: null, needsRefresh: true, message: result.kind === 'refused' ? refusals[result.code] ?? 'Captain refused access to these members and invitations.' : "Couldn't load members and invitations. Try again when the connection is available.", waitUntil: now() + (result.kind === 'unavailable' ? result.retryAfter : 0) * 1000 });
 };
 return {
  snapshot: () => state,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  dispose() { live = false; state = { ...state, data: null, invitation: null }; listeners.clear(); },
  refresh,
  async change(action: MemberAction) {
   if (!idle() || state.needsRefresh || !state.data || !memberChangeAllowed(state.data, scope, action)) return;
   if (action.kind === 'invite' && (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(action.email.trim()) || action.email.trim().length > 320)) {
    set({ ...state, message: 'Enter a valid email address.', invitation: null }); return;
   }
   set({ ...state, phase: 'saving', message: '', invitation: null });
   const result = await calls.change(scope, action);
   if (!live || result.kind === 'stale') return;
   if (result.kind === 'ok') {
    set({ ...state, phase: 'ready', needsRefresh: false, invitation: result.value, message: action.kind === 'invite' ? 'Invitation created. No email was sent. Copy the link and share it with the invited person.' : action.kind === 'revoke' ? 'Invitation revoked.' : action.kind === 'role' ? 'Role changed.' : 'Member removed.' });
    await refresh();
   } else if (result.kind === 'unavailable') {
    set({ ...state, phase: 'ready', needsRefresh: true, message: action.kind === 'invite' ? "Couldn't confirm whether the invitation was created. Refresh the list before creating another. A lost link cannot be retrieved; a new invitation for that email replaces the old one." : "Couldn't confirm that change. Refresh the list before making another change.", waitUntil: now() + result.retryAfter * 1000 });
   } else set({ ...state, phase: 'ready', needsRefresh: true, message: refusals[result.code] ?? 'Captain refused that change. Refresh and review the current details.' });
  }
 };
}
