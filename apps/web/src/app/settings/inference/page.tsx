import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { InferenceForm } from './InferenceForm.tsx';
export const metadata: Metadata = { title: 'Inference' };
type State = { role: 'owner' | 'admin' | 'member'; disabled: boolean; spritesConfigured?: boolean; runtime: { provider: 'claude' | 'codex' | 'anthropic_api'; status: 'provisioning' | 'needs_login' | 'ready' | 'failed' | 'removed'; loginHint: string | null; loginUrl: string | null } | null; budget: { month: string; limitTokens: number; usedTokens: number }; usage: { tier: string; inputTokens: number; outputTokens: number; calls: number }[] };
const states = { provisioning: 'Setting up', needs_login: 'Needs sign-in', ready: 'Ready', failed: 'Failed', removed: 'Disconnected' };
export default async function InferencePage() {
 const me = await requireCurrent('/settings/inference');
 return <Page title="Inference" lede="Your subscription powers triage, drafts and the brief.">
  <Suspense fallback={<div role="status"><Notice>Checking inference and this month’s allowance…</Notice></div>}><Details me={me} /></Suspense>
 </Page>;
}
async function Details({ me }: { me: Awaited<ReturnType<typeof requireCurrent>> }) {
 const result = await load(() => api<State>(`/v1/organisations/${me.organisation.organisationId}/inference`, { token: me.token }));
 if (!result.ok) return <Notice tone="failed" action={{ href: '/settings/inference', label: 'Try again' }}>{result.error.message} Try again to check inference.</Notice>;
 const { runtime, budget, usage, disabled, role, spritesConfigured = true } = result.value;
 const present = runtime && runtime.status !== 'removed'; const owner = role === 'owner';
 return <>
  {disabled ? <Notice>Inference is disabled. Ask the operator to finish configuring encryption.</Notice> : null}
  <section className="card"><h2>Subscription</h2>
   {present ? <><p>{{ claude: 'Claude', codex: 'Codex', anthropic_api: 'Anthropic API (not available)' }[runtime.provider]} · {states[runtime.status]}</p>{runtime.loginHint ? <p>{runtime.loginHint}</p> : null}
    {runtime.status === 'provisioning' ? <Notice>Captain is creating your runtime and installing the sign-in tools. This takes a few minutes the first time; refresh to check. Set the token allowance below while you wait.</Notice> : null}
    {runtime.status === 'needs_login' ? <Notice>The runtime is ready for sign-in. Signing in from this page arrives with the next update; until then the sign-in link appears here once the operator registers it.</Notice> : null}
    {runtime.status === 'failed' ? <Notice tone="attention" title="Setup or verification failed.">Disconnect the runtime and set it up again. If it keeps failing, ask the operator.</Notice> : null}
    {runtime.loginUrl && owner && runtime.status !== 'ready' ? <a href={runtime.loginUrl} className="button button--primary" target="_blank" rel="noreferrer">Complete sign-in</a> : null}
    <InferenceForm action="verify" disabled={!owner || disabled || runtime.provider === 'anthropic_api'} label="Verify sign-in" />
    <InferenceForm action="remove" disabled={!owner} label="Disconnect runtime" />
   </> : <>{spritesConfigured ? <Notice title="No inference subscription connected">Choose the subscription your business wants Captain to use. Setting up creates a private runtime for your organisation; it takes a few minutes.</Notice>
    : <Notice tone="attention" title="Runtimes cannot be created yet">This platform has no Sprites token configured. Ask the operator to set one, then set up your subscription here.</Notice>}
    <InferenceForm action="create" disabled={!owner || disabled || !spritesConfigured} label="Set up subscription"><div className="field"><label htmlFor="inference-provider">Provider</label><select id="inference-provider" name="provider" defaultValue="claude"><option value="claude">Claude</option><option value="codex">Codex</option></select></div></InferenceForm>
   </>}
   {!owner ? <p className="muted">Only an owner can set up, verify or disconnect the subscription.</p> : null}
   <p className="secondary">Each organisation gets its own runtime; your subscription is never shared with another business.</p>
  </section>
  <section className="card"><h2>Monthly token allowance</h2><p>{budget.month.slice(0, 7)} (UTC): {budget.usedTokens.toLocaleString('en-AU')} used of {budget.limitTokens.toLocaleString('en-AU')} tokens.</p>
   {budget.usedTokens >= budget.limitTokens ? <Notice>The allowance is spent. Increase it to use inference; other work can continue.</Notice> : null}
   <InferenceForm action="budget" disabled={role === 'member'} label="Save allowance"><div className="field"><label htmlFor="inference-limit">Monthly tokens</label><input id="inference-limit" name="limitTokens" type="number" min="0" step="1" max="9007199254740991" required defaultValue={budget.limitTokens} /></div></InferenceForm>
   <p className="secondary">The allowance renews each month. Provider subscription limits still apply.</p>
  </section>
  <section className="card"><h2>This month’s usage</h2>{usage.length ? <ul>{usage.map(row => <li key={row.tier}>{row.tier === 'small' ? 'Classification and extraction' : 'Drafts and brief'}: {row.inputTokens.toLocaleString('en-AU')} input tokens, {row.outputTokens.toLocaleString('en-AU')} output tokens ({row.calls} calls).</li>)}</ul> : <Notice>No inference usage recorded this month.</Notice>}</section>
 </>;
}
