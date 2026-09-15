'use client';
import { useActionState } from 'react';
import { controlRun } from './actions.ts';
export function RunControl({ id, action, disabled = false }: { id: string; action: 'run' | 'resume' | 'cancel'; disabled?: boolean }) {
 const [state, submit, pending] = useActionState(controlRun, undefined);
 return <form action={submit}>
  <input type="hidden" name="id" value={id} /><input type="hidden" name="action" value={action} />
  <button className="button button--secondary" disabled={disabled || pending} aria-busy={pending || undefined}>{pending ? 'Saving…' : action === 'run' ? 'Run now' : action === 'resume' ? 'Resume' : 'Cancel'}</button>
  {state?.error ? <p role="alert" className="form__error">{state.error}</p> : state?.ok ? <p role="status">Saved.</p> : null}
 </form>;
}
