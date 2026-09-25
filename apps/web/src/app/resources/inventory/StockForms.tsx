'use client';
import { useSaveForm } from '../../../components/SaveForm.tsx';
import { saveStock, type StockResult } from './stock-actions.ts';
export type StockItem = { id: string; name: string; location: string; unitLabel: string; currentCount: string | null; countedAt: string | null; countedByName: string | null;
 reorderPoint: string | null; belowReorder: boolean | null; preferredSupplierId: string | null; supplierName: string | null; notes: string; archivedAt: string | null };
export type Supplier = { id: string; name: string };
function Feedback({ result }: { result: StockResult | undefined }) { return result?.error ? <p className="form__error" role="alert">{result.error}</p> : result?.ok ? <p role="status">{result.ok}</p> : null; }
export function StockForm({ item, suppliers, locations }: { item?: StockItem; suppliers: Supplier[]; locations: string[] }) {
 const [result, action, pending] = useSaveForm((form) => saveStock(undefined, form)); const id = `stock-${item?.id ?? 'new'}`;
 return <form onSubmit={action} method="post" className="form stack">
  <input type="hidden" name="operation" value={item ? 'edit' : 'create'} /><input type="hidden" name="itemId" value={item?.id ?? ''} />
  <div className="row"><div className="field" style={{ flex: '1 1 200px' }}><label htmlFor={`${id}-name`}>Item name</label><input type="text" id={`${id}-name`} name="name" required maxLength={200} defaultValue={item?.name} /></div>
   <div className="field" style={{ flex: '1 1 180px' }}><label htmlFor={`${id}-location`}>Location</label><input type="text" id={`${id}-location`} name="location" required maxLength={200} list={`${id}-locations`} defaultValue={item?.location} />
    <datalist id={`${id}-locations`}>{locations.map((l) => <option key={l} value={l} />)}</datalist></div></div>
  <div className="row"><div className="field"><label htmlFor={`${id}-unit`}>Unit label</label><input type="text" id={`${id}-unit`} name="unitLabel" required maxLength={80} defaultValue={item?.unitLabel} readOnly={Boolean(item && item.currentCount !== null)} placeholder="bags, boxes, litres…" /></div>
   <div className="field"><label htmlFor={`${id}-reorder`}>Reorder point (optional)</label><input type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]+)?" maxLength={80} id={`${id}-reorder`} name="reorderPoint" defaultValue={item?.reorderPoint ?? ''} /></div></div>
  {item && item.currentCount !== null ? <p className="muted">The unit stays the same once an item has count history. Create a separate item for a different unit.</p> : null}
  <div className="field"><label htmlFor={`${id}-supplier`}>Preferred supplier (optional)</label><select id={`${id}-supplier`} name="preferredSupplierId" defaultValue={item?.preferredSupplierId ?? ''}>
   <option value="">No preferred supplier</option>{item?.preferredSupplierId && !suppliers.some((s) => s.id === item.preferredSupplierId) ? <option value={item.preferredSupplierId}>{item.supplierName} (archived)</option> : null}
   {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
  {!suppliers.length ? <p className="muted">Add suppliers in <a href="/settings/contacts">People and companies</a>.</p> : null}
  <div className="field"><label htmlFor={`${id}-notes`}>Item notes</label><textarea id={`${id}-notes`} name="notes" maxLength={5000} defaultValue={item?.notes} /></div>
  <Feedback result={result} /><div className="row"><button className="button button--secondary" disabled={pending} aria-busy={pending || undefined}>{pending ? 'Saving…' : item ? 'Save item' : 'Add stock item'}</button></div>
 </form>;
}
export function CountForm({ item }: { item: StockItem }) {
 const [result, action, pending] = useSaveForm((form) => saveStock(undefined, form));
 return <form onSubmit={action} method="post" className="form stack"><input type="hidden" name="operation" value="count" /><input type="hidden" name="itemId" value={item.id} />
  <div className="row"><div className="field"><label htmlFor={`count-${item.id}`}>Count now ({item.unitLabel})</label>
   <input type="text" inputMode="decimal" id={`count-${item.id}`} name="count" aria-label={`Count for ${item.name}`} pattern="[0-9]+([.][0-9]+)?" maxLength={80} required disabled={pending || Boolean(item.archivedAt)} /></div>
   <button className="button button--secondary" disabled={pending || Boolean(item.archivedAt)} aria-busy={pending || undefined}>{pending ? 'Saving…' : 'Save count'}</button></div><Feedback result={result} />
 </form>;
}
export function ArchiveStock({ item }: { item: StockItem }) {
 const [result, action, pending] = useSaveForm((form) => saveStock(undefined, form));
 return <form onSubmit={action} method="post"><input type="hidden" name="operation" value={item.archivedAt ? 'restore' : 'archive'} /><input type="hidden" name="itemId" value={item.id} />
  <button className="button button--ghost button--small" disabled={pending}>{pending ? 'Saving…' : item.archivedAt ? 'Restore item' : 'Archive item'}</button><Feedback result={result} /></form>;
}
