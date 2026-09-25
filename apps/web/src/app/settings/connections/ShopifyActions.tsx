'use client';
import { useState, type FormEvent } from 'react';
import { useSaveForm } from '../../../components/SaveForm.tsx';
import { shopifyAction } from './shopify-actions.ts';
export function ShopifyActions({ disabled, available, connected, shop }: { disabled: boolean; available: boolean; connected: boolean; shop?: string }) {
 const [error, setError] = useState<string>(); const [starting, setStarting] = useState(false); const [result, action, pending] = useSaveForm(shopifyAction);
 async function start(event: FormEvent<HTMLFormElement>) {
  event.preventDefault(); if (starting) return; const form = new FormData(event.currentTarget); setStarting(true); setError(undefined);
  try { const response = await shopifyAction(form); if (response.authorizationUrl) { window.location.assign(response.authorizationUrl); return; } setError(response.error); }
  catch { setError('Shopify could not be opened. Try again.'); } setStarting(false);
 }
 return <div className="stack"><form className="form" method="post" onSubmit={start}>
  <input type="hidden" name="operation" value="start" /><div className="field"><label htmlFor="shopify-shop">Shop domain</label>
   <input id="shopify-shop" name="shop" defaultValue={shop} placeholder="your-shop.myshopify.com" required maxLength={100} autoCapitalize="none" disabled={disabled || !available || pending || starting} /></div>
  <button className="button" disabled={disabled || !available || pending || starting}>{starting ? 'Opening Shopify…' : shop ? 'Reconnect Shopify' : 'Connect Shopify'}</button>
 </form><div className="row">{(['sync', 'disconnect'] as const).filter((op) => op === 'sync' ? connected : Boolean(shop)).map((operation) => <form key={operation} method="post" onSubmit={action}>
  <input type="hidden" name="operation" value={operation} /><button className="button button--secondary" disabled={disabled || pending || starting || (operation === 'sync' && !available)}>{operation === 'sync' ? 'Sync now' : 'Disconnect Shopify'}</button>
 </form>)}</div>{pending ? <p role="status">Updating Shopify…</p> : null}
 {error || result?.error ? <p className="form__error" role="alert">{error || result?.error}</p> : null}</div>;
}
export function ShopifyReorder({ id, value }: { id: string; value: string | null }) {
 const [state, action, pending] = useSaveForm(shopifyAction);
 return <form className="form" method="post" onSubmit={action}><input type="hidden" name="operation" value="reorder" /><input type="hidden" name="itemId" value={id} />
  <div className="field"><label>Reorder point for this variant<input name="reorderPoint" type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" maxLength={80} defaultValue={value ?? ''} disabled={pending} /></label></div>
  <p className="muted">Applies separately at each Shopify location. Leave blank for no threshold.</p>
  <button className="button button--secondary" disabled={pending}>{pending ? 'Saving…' : 'Save reorder point'}</button>{state?.error ? <p role="alert" className="form__error">{state.error}</p> : null}
 </form>;
}
