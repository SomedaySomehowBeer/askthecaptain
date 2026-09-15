'use client';
import { useActionState } from 'react';
import { connectXero, xeroAction } from './xero-actions.ts';
export function XeroActions({ disabled, available, connected, reconnect, selection }: { disabled: boolean; available: boolean; connected: boolean; reconnect: boolean; selection: { id: string; tenants: { tenantId: string; tenantName: string }[] } | null }) {
 const [startResult, start, starting] = useActionState(connectXero, undefined);
 const [result, action, pending] = useActionState(xeroAction, undefined); const busy = pending || starting;
 return <div className="stack">
  {selection && !disabled ? <form action={action} className="form stack"><input type="hidden" name="operation" value="select" /><input type="hidden" name="selectionId" value={selection.id} />
   <label htmlFor="xero-tenant">Choose your Xero organisation</label><select id="xero-tenant" name="tenantId" required disabled={busy || !available}>{selection.tenants.map((t) => <option value={t.tenantId} key={t.tenantId}>{t.tenantName}</option>)}</select>
   <button className="button" disabled={busy || !available}>{pending ? 'Connecting…' : 'Use this organisation'}</button></form> : null}
  <div className="row"><form action={start}><button className="button" disabled={disabled || !available || busy}>{starting ? 'Opening Xero…' : reconnect ? 'Reconnect Xero' : 'Connect Xero'}</button></form>
   {connected ? <form action={action}><input type="hidden" name="operation" value="sync" /><button className="button button--ghost" disabled={disabled || !available || busy}>{pending ? 'Working…' : 'Sync now'}</button></form> : null}
   {reconnect ? <form action={action}><input type="hidden" name="operation" value="disconnect" /><button className="button button--ghost" disabled={disabled || busy}>{pending ? 'Working…' : 'Disconnect Xero'}</button></form> : null}</div>
  {startResult?.error || result?.error ? <p className="form__error" role="alert">{startResult?.error || result?.error}</p> : null}
  {result?.ok ? <p role="status">{result.ok}</p> : null}
 </div>;
}
