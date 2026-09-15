import { Notice } from '../../../components/Notice.tsx';
import { requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { XeroActions } from './XeroActions.tsx';
type State = { available: boolean; scheduled: boolean; connection: { id: string; providerAccountName: string; status: string; error: string | null } | null; selection: { id: string; tenants: { tenantId: string; tenantName: string }[] } | null; lastSyncedAt: string | null; complete: boolean; syncError: string | null };
export async function XeroCard({ me, outcome }: { me: Awaited<ReturnType<typeof requireCurrent>>; outcome?: string }) {
 const result = await load(() => api<State>(`/v1/organisations/${me.organisation.organisationId}/xero/connection`, { token: me.token }));
 const canManage = me.organisation.role !== 'member'; const state = result.ok ? result.value : null; const c = state?.connection;
 return <section className="card stack"><h2>Xero</h2><p className="secondary">Connect Xero so Captain can read invoices, payments and contacts for chasing overdue invoices and the money brief.</p>
  {outcome === 'failed' ? <Notice tone="failed">Xero could not be connected. Start Connect Xero again and allow the requested read access.</Notice> : null}
  {!result.ok ? <Notice tone="failed" action={{ href: '/settings/connections', label: 'Try again' }}>{result.error.message} Xero connection status could not be checked.</Notice> : null}
  {state ? <>
   {c ? <><div className="line"><span>Organisation</span><span>{c.providerAccountName}</span></div><div className="line"><span>Status</span><span>{c.status === 'connected' ? 'Connected' : c.status === 'disconnected' ? 'Disconnected' : 'Access could not be refreshed'}</span></div>
    {c.error ? <Notice tone="attention">{c.error}</Notice> : null}</> : <Notice title="Xero is not connected">An owner or admin can connect the business’s Xero organisation here.</Notice>}
   {!state.available ? <Notice>Xero connections are not configured. Ask the owner to finish setup.</Notice> : null}
   {c?.status === 'connected' ? <><p>{state.scheduled ? 'Xero is checked every 15 minutes.' : 'Automatic Xero checks are paused. Use Sync now.'}</p>
    <p>{state.lastSyncedAt ? `Last completed sync: ${new Date(state.lastSyncedAt).toLocaleString('en-AU', { timeZone: 'UTC', timeZoneName: 'short' })}` : 'Xero has not completed a sync yet.'}</p>
    {!state.complete ? <Notice tone="attention">{state.syncError ?? 'Cached money may be incomplete. Choose Sync now.'}</Notice> : null}</> : null}
   {!canManage ? <Notice>You can see connections. Only owners and admins can connect, sync or disconnect Xero.</Notice> : null}
   <XeroActions disabled={!canManage} available={state.available} connected={c?.status === 'connected'} reconnect={Boolean(c && c.status !== 'disconnected')} selection={state.selection} />
  </> : null}
 </section>;
}
