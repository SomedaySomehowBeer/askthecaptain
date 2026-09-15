'use client';
import { useActionState } from 'react';
import { updateInference } from './actions.ts';
export function InferenceForm({ action, disabled, children, label }: { action: string; disabled: boolean; children?: React.ReactNode; label: string }) {
 const [state, submit, pending] = useActionState(updateInference, {});
 return <form action={submit} className="stack">
  <input type="hidden" name="action" value={action} />
  <fieldset disabled={disabled || pending} className="form" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{children}<div className="row"><button className="button button--secondary" type="submit" aria-busy={pending}>{pending ? 'Working…' : label}</button></div></fieldset>
  {state.error ? <p role="alert" className="form__error">{state.error}</p> : state.message ? <p role="status">{state.message}</p> : null}
 </form>;
}
