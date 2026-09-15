import { Notice } from '../../../components/Notice.tsx';
import type { requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { ShopifyActions } from './ShopifyActions.tsx';
export async function ShopifyCard({ me, outcome }: { me: Awaited<ReturnType<typeof requireCurrent>>; outcome?: string }) {
 const result = await load(() => api<{ available: boolean; connected: boolean; connection: { providerAccountId: string; status: string } | null; complete: boolean; lastSyncedAt: string | null; error: string | null; scheduled: boolean }>(`/v1/organisations/${me.organisation.organisationId}/shopify/connection`, { token: me.token }));
 return <section className="card stack" aria-labelledby="shopify-heading"><h2 id="shopify-heading">Shopify</h2><p>Read shop stock and orders. Quantities come from Shopify; set reorder points in Commitments.</p>
  {outcome === 'failed' ? <Notice tone="failed">Shopify could not be connected. Start Connect Shopify again and allow the requested access.</Notice> : null}
  {!result.ok ? <Notice tone="failed" action={{ href: '/settings/connections', label: 'Try again' }}>{result.error.message} Shopify connection status could not be checked.</Notice> : <>
   <p>{result.value.connected ? `Connected to ${result.value.connection!.providerAccountId}` : result.value.connection ? 'Shopify is disconnected or needs attention.' : 'Shopify is not connected.'}</p>
   {result.value.error ? <Notice tone="attention">{result.value.error}</Notice> : null}
   {result.value.lastSyncedAt ? <p className="secondary">Last completed sync: {new Date(result.value.lastSyncedAt).toISOString()}.</p> : null}
   <p className="secondary">{result.value.scheduled ? 'Shop data is checked every 15 minutes.' : 'Automatic Shopify checks are paused.'} Orders cover the accessible last 60 days.</p>
   {!result.value.available ? <Notice>Shopify connections are not configured. Ask the owner to finish setup.</Notice> : null}
   {me.organisation.role === 'member' ? <p>Only an owner or admin can connect, sync or disconnect Shopify.</p> : null}
   <ShopifyActions disabled={me.organisation.role === 'member'} available={result.value.available} connected={result.value.connected} shop={result.value.connection?.providerAccountId} />
  </>}
 </section>;
}
