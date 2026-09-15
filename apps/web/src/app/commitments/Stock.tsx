import { Suspense } from 'react';
import { Stocktake } from './Stocktake.tsx';
import { ShopifyStock } from './ShopifyStock.tsx';
import { Notice } from '../../components/Notice.tsx';
import { requireCurrent } from '../../components/Page.tsx';
import { api, load } from '../../lib/api.ts';
import { ArchiveStock, CountForm, StockForm, type StockItem, type Supplier } from './StockForms.tsx';
type Stock = { items: StockItem[]; locations: string[]; suppliers: Supplier[]; timezone: string };
export async function StockSection({ me, shopifyOffset = 0 }: { me: Awaited<ReturnType<typeof requireCurrent>>; shopifyOffset?: number }) {
 const [result, shopify] = await Promise.all([load(() => api<Stock>(`/v1/organisations/${me.organisation.organisationId}/stock?includeArchived=1`, { token: me.token })), ShopifyStock({ me, offset: shopifyOffset })]);
 if (!result.ok) return <section className="card" aria-labelledby="stock-heading" id="stock"><h2 id="stock-heading">Stock</h2><Notice tone="failed" action={{ href: '/commitments', label: 'Try again' }}>{result.error.message} The stock list could not be read.</Notice>{shopify}</section>;
 const { items, locations, suppliers, timezone } = result.value;
 const active = items.filter((i) => !i.archivedAt); const archived = items.filter((i) => i.archivedAt);
 const line = (item: StockItem) => <article className="stack" key={item.id} aria-label={item.name} style={{ borderTop: '1px solid var(--line)', paddingTop: '1rem', overflowWrap: 'anywhere' }}>
  <div className="row row--between"><h4>{item.name}</h4><ArchiveStock item={item} /></div>
  <p>{item.currentCount === null ? 'Not counted yet.' : `${item.currentCount} ${item.unitLabel}`}</p>
  {item.countedAt ? <p className="secondary">Counted {new Date(item.countedAt).toLocaleString('en-AU', { timeZone: timezone })} by {item.countedByName}.</p> : null}
  {item.reorderPoint !== null ? <p className="secondary">Reorder point: {item.reorderPoint} {item.unitLabel}.{item.currentCount === null ? ' Count this item to check whether it needs reordering.' : ''}</p> : null}
  {item.belowReorder && !item.archivedAt ? <Notice tone="attention">Below reorder point.</Notice> : null}
  {item.supplierName ? <p className="secondary">Preferred supplier: {item.supplierName}</p> : null}{item.notes ? <p>{item.notes}</p> : null}
  <CountForm item={item} />
  {!item.archivedAt ? <details className="disclosure"><summary>Edit item</summary><StockForm item={item} suppliers={suppliers} locations={locations} /></details> : <p className="muted">Archived. Restore this item before counting or editing it.</p>}
 </article>;
 return <section className="card stack" aria-labelledby="stock-heading" id="stock"><h2 id="stock-heading">Stock</h2><p className="secondary">Count what is here, by location. Each count is recorded with who entered it and when.</p>
  {!active.some((i) => i.currentCount !== null) ? <Notice title="Nothing is counted yet…">{active.length ? 'Enter a count for an item below to check its reorder point.' : 'Add an item and its location, then enter what you count.'}</Notice> : null}
  <Suspense fallback={<p role="status">Checking stocktake availability…</p>}><Stocktake me={me} locations={locations} /></Suspense>
  {locations.map((location) => <div className="stack" key={location}><h3>{location}</h3>{active.filter((i) => i.location === location).map(line)}</div>)}
  <details className="disclosure"><summary>Add a stock item</summary><StockForm suppliers={suppliers} locations={locations} /></details>
  {archived.length ? <details className="disclosure"><summary>Archived stock ({archived.length})</summary><div className="stack">{archived.map((item) => <div key={item.id}><p className="secondary">{item.location}</p>{line(item)}</div>)}</div></details> : null}
  {shopify}
 </section>;
}
