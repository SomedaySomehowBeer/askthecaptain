'use client';
import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from 'react';
type SaveResult = { error?: string } | void;
type Save = (form: FormData) => Promise<SaveResult>;
// Native submit handling retains entered values on errors. Successful actions revalidate
// their page; React applies the result and refreshed tree in the same transition.
export function useSaveForm(save: Save) {
 const confirmed = useRef<HTMLFormElement | undefined>(undefined);
 const [state, dispatch, pending] = useActionState<SaveResult, { data: FormData; element: HTMLFormElement }>(async (_, { data, element }) => {
  try {
   const result = await save(data);
   if (!result?.error) confirmed.current = element;
   return result;
  } catch { return { error: 'The save could not be confirmed. Reload the page to check before trying again.' }; }
 }, undefined);
 useEffect(() => {
  if (!pending && confirmed.current) { confirmed.current.reset(); confirmed.current = undefined; }
 }, [pending]);
 function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (pending) return;
  const element = event.currentTarget;
  const data = new FormData(element, (event.nativeEvent as SubmitEvent).submitter);
  startTransition(() => dispatch({ data, element }));
 }
 return [state || undefined, submit, pending] as const;
}
export function SaveForm({ action, children }: { action: Save; children: ReactNode }) {
 const [state, submit, pending] = useSaveForm(action);
 return <form onSubmit={submit} method="post" aria-busy={pending || undefined}>
  <fieldset disabled={pending} style={{ display: 'contents' }}>{children}</fieldset>
  {state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}
 </form>;
}
