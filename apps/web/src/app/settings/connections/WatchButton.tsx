'use client';
import { useActionState } from 'react';
import { startWatch } from './watch-action.ts';
export function WatchButton({ disabled }: { disabled: boolean }) {
 const [state, action, pending] = useActionState(startWatch, undefined);
 return <form action={action}><button className="button button--secondary" disabled={disabled || pending}>{pending ? 'Starting…' : 'Start live mail updates'}</button>
  {state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}{state?.ok ? <p role="status">Live mail updates started.</p> : null}
 </form>;
}
