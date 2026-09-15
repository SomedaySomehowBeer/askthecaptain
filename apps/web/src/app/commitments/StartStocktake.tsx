'use client';
import { useState, type FormEvent } from 'react';
import { startStocktake } from './stocktake-actions.ts';
export function StartStocktake({ disabled, locations, location }: { disabled: boolean; locations: string[]; location: string }) {
 const [pending, setPending] = useState(false), [error, setError] = useState<string>();
 async function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (pending) return; setPending(true); setError(undefined);
  try { const result = await startStocktake(new FormData(event.currentTarget)); if (result.runId) { window.location.assign(`/settings/workflows?run=${encodeURIComponent(result.runId)}`); return; } setError(result.error); }
  catch { setError('The stocktake could not be started. Check Activity before trying again.'); } setPending(false);
 }
 return <form className="form" method="post" onSubmit={submit}><div className="field"><label htmlFor="stocktake-location">Location to count</label>
  <input type="text" id="stocktake-location" name="location" defaultValue={location} list="stocktake-locations" required maxLength={200} disabled={disabled || pending} />
  <datalist id="stocktake-locations">{locations.map(l => <option value={l} key={l} />)}</datalist></div>
  <button className="button button--primary" disabled={disabled || pending}>{pending ? 'Starting stocktake…' : 'Start a stocktake'}</button>
  {pending ? <p role="status">Starting the stocktake…</p> : null}{error ? <p role="alert" className="form__error">{error}</p> : null}
 </form>;
}
