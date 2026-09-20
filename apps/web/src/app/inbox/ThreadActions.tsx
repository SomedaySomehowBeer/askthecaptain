'use client';
import { useActionState } from 'react';
import { threadAction } from './actions.ts';
/** On a needs-you thread without a draft the split button is Draft a reply, with Not needed and Remind me later in its menu (plan §6).
 *  Asking for a draft is the strongest up signal for this sender's draft score. */
export function ThreadActions({ threadId, remindAt, timezone, connected }: { threadId: string; remindAt: string | null; timezone: string; connected: boolean }) {
 const [state, submit, pending] = useActionState(threadAction, undefined);
 const fields = (action: string, when?: string) => <><input type="hidden" name="threadId" value={threadId} /><input type="hidden" name="action" value={action} />{when ? <input type="hidden" name="when" value={when} /> : null}</>;
 const reminder = remindAt && new Date(remindAt).getTime() > Date.now() ? new Date(remindAt).toLocaleString('en-AU', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
 return <section className="card stack"><h2>This needs you</h2>
  <p className="muted">{reminder ? `Reminder set for ${reminder}. ` : ''}No reply has been drafted. Ask for one, hold it for later, or say no reply is wanted.</p>
  <div className="split">
   <form action={submit}>{fields('draft')}<button className="button button--primary" disabled={pending || !connected}>{pending ? 'Working…' : 'Draft a reply'}</button></form>
   <details className="menu"><summary className="button button--secondary" aria-label="More actions for this thread">▾</summary>
    <div className="menu__list">
     <form action={submit}>{fields('remind', 'tomorrow')}<button className="menu__item" disabled={pending}>Remind me tomorrow morning</button></form>
     <form action={submit}>{fields('remind', 'next_week')}<button className="menu__item" disabled={pending}>Remind me next week</button></form>
     <form action={submit}>{fields('not_needed')}<button className="menu__item" disabled={pending}>Not needed: no reply wanted</button></form>
    </div>
   </details>
  </div>
  {!connected ? <p>Reconnect Google in Settings before drafting.</p> : null}
  {state?.error ? <p role="alert">{state.error}</p> : state?.message ? <p role="status">{state.message}</p> : null}
 </section>;
}
