'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
type SaveResult = { error?: string } | void;
type Save = (form: FormData) => Promise<SaveResult>;
// A small action response followed by a fresh document avoids production RSC revalidation
// leaving a persisted write stuck in a pending transition. Failed forms retain their values.
export function useSaveForm(save: Save) {
 const [state, setState] = useState<{ error?: string }>(); const [pending, setPending] = useState(false);
 async function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (pending) return;
  const form = new FormData(event.currentTarget, (event.nativeEvent as SubmitEvent).submitter); setPending(true); setState(undefined);
  try { const result = await save(form); if (!result?.error) { window.location.reload(); return; } setState(result); }
  catch { setState({ error: 'The save could not be confirmed. Reload the page to check before trying again.' }); }
  setPending(false);
 }
 return [state, submit, pending] as const;
}
export function SaveForm({ action, children }: { action: Save; children: ReactNode }) {
 const [state, submit, pending] = useSaveForm(action);
 return <form onSubmit={submit} method="post" aria-busy={pending || undefined}>
  <fieldset disabled={pending} style={{ display: 'contents' }}>{children}</fieldset>
  {state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}
 </form>;
}
