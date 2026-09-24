import { Notice } from '../../components/Notice.tsx';
import type { requireCurrent } from '../../components/Page.tsx';
import { api, load } from '../../lib/api.ts';
import { ShopifyReorder } from '../settings/connections/ShopifyActions.tsx';
type ShopStock = { connected: boolean; complete: boolean; error: string | null; lastSyncedAt: string | null; nextOffset: number | null;
 items: { id: string; providerId: string; title: string; variantTitle: string; sku: string | null; tracked: boolean; locationProviderId: string | null; locationName: string | null; available: number | null; updatedAt: string | null; reorderPoint: string | null; belowReorder: boolean | null }[] };
export async function ShopifyStock({ me, offset = 0, basePath = '/commitments' }: { me: Awaited<ReturnType<typeof requireCurrent>>; offset?: number; basePath?: string }) {
 const result = await load(() => api<ShopStock>(`/v1/organisations/${me.organisation.organisationId}/shopify/stock?offset=${offset}`, { token: me.token }));
 return <div className="stack" id="shopify-stock"><h3>Shop stock</h3>
  {!result.ok ? <Notice tone="failed">{result.error.message} Shopify stock could not be read. <a href={basePath}>Try again</a>.</Notice> : <>
   {!result.value.connected ? <Notice>Connect Shopify in <a href="/settings/connections">Settings → Connections</a> to read shop quantities here.</Notice> : <>
    {!result.value.complete ? <Notice tone="attention">{result.value.error ?? 'Shopify has not completed a sync. Check the connection in Settings.'}</Notice> : null}
    <p className="secondary">From Shopify. {result.value.lastSyncedAt ? `Last completed sync: ${new Date(result.value.lastSyncedAt).toISOString()}. Quantities may have changed since then.` : 'No completed sync yet.'} Shopify quantities cannot be counted by hand.</p>
    {result.value.complete && !result.value.items.length ? <p>No active Shopify variants on this page.</p> : null}
    {result.value.items.map((item) => <article className="stack" key={`${item.id}-${item.locationProviderId}`} aria-label={`${item.title} — ${item.locationName ?? 'no location'}`}>
     <h4>{item.title}{item.variantTitle !== 'Default Title' ? ` — ${item.variantTitle}` : ''}</h4><p className="secondary">from Shopify · {item.locationName ?? 'No location reported'}{item.sku ? ` · ${item.sku}` : ''}</p>
     <p>{!item.tracked ? 'Inventory is not tracked in Shopify.' : item.available === null ? 'No quantity has been reported for this variant.' : `${item.available} available`}</p>
     {item.belowReorder ? <Notice tone="attention">Below reorder point.</Notice> : null}
     {item.reorderPoint !== null ? <p>Reorder point: {item.reorderPoint}</p> : null}
     <details className="disclosure"><summary>Set reorder point</summary><ShopifyReorder id={item.id} value={item.reorderPoint} /></details>
    </article>)}
    <div className="row">{offset > 0 ? <a href={`${basePath}?shopifyOffset=${Math.max(0, offset - 200)}#shopify-stock`}>Previous shop stock</a> : null}{result.value.nextOffset !== null ? <a href={`${basePath}?shopifyOffset=${result.value.nextOffset}#shopify-stock`}>More shop stock</a> : null}</div>
   </>}
  </>}
 </div>;
}
