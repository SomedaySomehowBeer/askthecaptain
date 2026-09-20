'use client';
import { useActionState, useState } from 'react';
import { changeDraft } from './actions.ts';
import type { Draft } from './mail.ts';
/** The control on a drafted reply is a split button (plan §6): Send is the action; its menu holds Edit, Remind me later,
 *  Not needed and Discard. Each outcome teaches the sender's draft score. Only Send sends, and only a person presses it (D5). */
const ended: Record<NonNullable<Draft['outcome']>, string> = { sent: 'Sent by a person.', edited_sent: 'Edited, then sent by a person.', discarded: 'Discarded.', not_needed: 'Marked not needed: no reply wanted.', expired: 'Expired untouched after seven days.' };
export function DraftForm({ draft, connected, timezone }: { draft: Draft; connected: boolean; timezone?: string }) {
 const [state, submit, pending] = useActionState(changeDraft, undefined); const [body, setBody] = useState(draft.body); const [editing, setEditing] = useState(false);
 const dirty = body !== draft.body; const uncertain = !!draft.sendStartedAt;
 const fields = (action: string, when?: string) => <><input type="hidden" name="id" value={draft.id} /><input type="hidden" name="action" value={action} />{when ? <input type="hidden" name="when" value={when} /> : null}</>;
 const reminder = draft.remindAt && new Date(draft.remindAt).getTime() > Date.now() ? new Date(draft.remindAt).toLocaleString('en-AU', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : null;
 return <section className="card stack"><h2>{draft.subject || '(No subject)'}</h2><p>To: {draft.to.join(', ') || 'Recipient unavailable'}</p>{draft.cc.length ? <p>Cc: {draft.cc.join(', ')}</p> : null}
  {draft.state !== 'drafted' ? <><p role="status">{ended[draft.outcome ?? (draft.state === 'sent' ? 'sent' : 'discarded')]}</p><p className="mail-body">{draft.body}</p></> : <>
   {editing || dirty
    ? <form action={submit} className="stack">{fields('edit')}<label className="stack">Reply draft<textarea name="body" value={body} onChange={e => setBody(e.target.value)} rows={8} maxLength={20000} required disabled={pending || uncertain} /></label>
      <div className="row"><button className="button button--secondary" disabled={pending || uncertain || !dirty}>{pending ? 'Working…' : 'Save draft'}</button><button type="button" className="button button--ghost" onClick={() => { setBody(draft.body); setEditing(false); }} disabled={pending}>Cancel</button></div></form>
    : <p className="mail-body">{draft.body}</p>}
   {reminder ? <p className="muted">Reminder set for {reminder}.</p> : null}
   {uncertain ? <p role="status">Sending has not been confirmed. Check Sent in Gmail, then check again here. Captain will not send a second copy.</p> : <p className="muted">Review the draft. Only you can send it.{draft.edited ? ' You have edited it.' : ''}</p>}
   <div className="split">
    <form action={submit}>{fields('send')}<button className="button button--primary" disabled={pending || dirty || !connected || !draft.to.length}>{pending ? 'Working…' : uncertain ? 'Check send' : 'Send'}</button></form>
    <details className="menu"><summary className="button button--secondary" aria-label="More actions for this draft">▾</summary>
     <div className="menu__list">
      <button type="button" className="menu__item" onClick={() => setEditing(true)} disabled={pending || uncertain}>Edit</button>
      <form action={submit}>{fields('remind', 'tomorrow')}<button className="menu__item" disabled={pending || uncertain}>Remind me tomorrow morning</button></form>
      <form action={submit}>{fields('remind', 'next_week')}<button className="menu__item" disabled={pending || uncertain}>Remind me next week</button></form>
      <form action={submit}>{fields('not_needed')}<button className="menu__item" disabled={pending || uncertain}>Not needed: no reply wanted</button></form>
      <form action={submit}>{fields('discard')}<button className="menu__item menu__item--danger" disabled={pending || uncertain}>Discard this draft</button></form>
     </div>
    </details>
   </div>
   {!connected ? <p>Reconnect Google in Settings before sending.</p> : null}
   {state?.error ? <p role="alert">{state.error}</p> : state?.ok ? <p role="status">Saved.</p> : null}
  </>}
 </section>;
}
