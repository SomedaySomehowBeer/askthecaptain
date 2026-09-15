'use client';
import { useActionState, useState } from 'react';
import { changeDraft } from './actions.ts';
import type { Draft } from './mail.ts';
export function DraftForm({ draft, connected }: { draft: Draft; connected: boolean }) {
 const [state, submit, pending] = useActionState(changeDraft, undefined); const [body, setBody] = useState(draft.body);
 const dirty = body !== draft.body; const uncertain = !!draft.sendStartedAt;
 const fields = (action: string) => <><input type="hidden" name="id" value={draft.id} /><input type="hidden" name="action" value={action} /></>;
 return <section className="card stack"><h2>{draft.subject || '(No subject)'}</h2><p>To: {draft.to.join(', ') || 'Recipient unavailable'}</p>{draft.cc.length ? <p>Cc: {draft.cc.join(', ')}</p> : null}
  {draft.state !== 'drafted' ? <><p role="status">{draft.state === 'sent' ? 'Sent by a person.' : 'Discarded.'}</p><p className="mail-body">{draft.body}</p></> : <>
   <form action={submit} className="stack">{fields('edit')}<label className="stack">Reply draft<textarea name="body" value={body} onChange={e => setBody(e.target.value)} rows={8} maxLength={20000} required disabled={pending || uncertain} /></label>
    <button className="button button--secondary" disabled={pending || uncertain || !dirty}>Save draft</button>
   </form>
   {uncertain ? <p role="status">Sending has not been confirmed. Check Sent in Gmail, then check again here. Captain will not send a second copy.</p> : <p className="muted">Review the draft. Only you can send it. Save any edits before sending.</p>}
   <div className="row"><form action={submit}>{fields('send')}<button className="button button--primary" disabled={pending || dirty || !connected || !draft.to.length}>{pending ? 'Working…' : uncertain ? 'Check send' : 'Send'}</button></form>
    <form action={submit}>{fields('discard')}<button className="button button--ghost" disabled={pending || uncertain}>Discard</button></form></div>
   {!connected ? <p>Reconnect Google in Settings before sending.</p> : null}
   {state?.error ? <p role="alert">{state.error}</p> : state?.ok ? <p role="status">Saved.</p> : null}
  </>}
 </section>;
}
