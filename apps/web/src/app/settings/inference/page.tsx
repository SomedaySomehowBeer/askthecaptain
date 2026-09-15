import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { InferenceForm } from './InferenceForm.tsx';
export const metadata: Metadata = { title: 'Inference' };
type State = { role: 'owner' | 'admin' | 'member'; disabled: boolean; runtime: { provider: 'claude' | 'codex' | 'anthropic_api'; status: 'provisioning' | 'needs_login' | 'ready' | 'failed' | 'removed'; loginHint: string | null; loginUrl: string | null } | null; budget: { month: string; limitTokens: number; usedTokens: number }; usage: { tier: string; inputTokens: number; outputTokens: number; calls: number }[] };
const states = { provisioning: 'Waiting for setup', needs_login: 'Needs sign-in', ready: 'Ready', failed: 'Verification failed', removed: 'Disconnected' };
export default async function InferencePage() {
 const me = await requireCurrent('/settings/inference');
 return <Page title="Inference" lede="Your subscription powers triage, drafts and the brief.">
  <Suspense fallback={<div role="status"><Notice>Checking inference and this month’s allowance…</Notice></div>}><Details me={me} /></Suspense>
 </Page>;
}
async function Details({ me }: { me: Awaited<ReturnType<typeof requireCurrent>> }) {
 const result = await load(() => api<State>(`/v1/organisations/${me.organisation.organisationId}/inference`, { token: me.token }));
 if (!result.ok) return <Notice tone="failed" action={{ href: '/settings/inference', label: 'Try again' }}>{result.error.message} Try again to check inference.</Notice>;
 const { runtime, budget, usage, disabled, role } = result.value;
 const present = runtime && runtime.status !== 'removed'; const owner = role === 'owner';
 return <>
  {disabled ? <Notice>Inference is disabled. Ask the operator to finish configuring encryption.</Notice> : null}
  <section className="card"><h2>Subscription</h2>
   {present ? <><p>{{ claude: 'Claude', codex: 'Codex', anthropic_api: 'Anthropic API (not available)' }[runtime.provider]} · {states[runtime.status]}</p>{runtime.loginHint ? <p>{runtime.loginHint}</p> : null}
    {runtime.status !== 'ready' ? <Notice>Ask the operator to finish setup and sign in to your organisation’s subscription, then verify it here. Increase the token allowance below before verifying.</Notice> : null}
    {runtime.loginUrl && owner && runtime.status !== 'ready' ? <a href={runtime.loginUrl} className="button button--primary" target="_blank" rel="noreferrer">Complete sign-in</a> : null}
    {runtime.status !== 'ready' ? <p>Open the sign-in link when it appears. Claude may return a code to paste into the operator’s sign-in session; Codex asks for the device code from that session.</p> : null}
    <InferenceForm action="verify" disabled={!owner || disabled || runtime.provider === 'anthropic_api'} label="Verify sign-in" />
    <InferenceForm action="remove" disabled={!owner} label="Disconnect runtime" />
   </> : <><Notice title="No inference subscription connected">Choose the subscription your business wants Captain to use.</Notice>
    <InferenceForm action="create" disabled={!owner || disabled} label="Set up subscription"><div className="field"><label htmlFor="inference-provider">Provider</label><select id="inference-provider" name="provider" defaultValue="claude"><option value="claude">Claude</option><option value="codex">Codex</option></select></div></InferenceForm>
   </>}
   {!owner ? <p className="muted">Only an owner can set up, verify or disconnect the subscription.</p> : null}
   <p className="secondary">The operator creates a dedicated runtime for your organisation, then starts sign-in. This keeps your subscription separate from other businesses.</p>
  </section>
  <section className="card"><h2>Monthly token allowance</h2><p>{budget.month.slice(0, 7)} (UTC): {budget.usedTokens.toLocaleString('en-AU')} used of {budget.limitTokens.toLocaleString('en-AU')} tokens.</p>
   {budget.usedTokens >= budget.limitTokens ? <Notice>The allowance is spent. Increase it to use inference; other work can continue.</Notice> : null}
   <InferenceForm action="budget" disabled={role === 'member'} label="Save allowance"><div className="field"><label htmlFor="inference-limit">Monthly tokens</label><input id="inference-limit" name="limitTokens" type="number" min="0" step="1" max="9007199254740991" required defaultValue={budget.limitTokens} /></div></InferenceForm>
   <p className="secondary">The allowance renews each month. Provider subscription limits still apply.</p>
  </section>
  <section className="card"><h2>This month’s usage</h2>{usage.length ? <ul>{usage.map(row => <li key={row.tier}>{row.tier === 'small' ? 'Classification and extraction' : 'Drafts and brief'}: {row.inputTokens.toLocaleString('en-AU')} input tokens, {row.outputTokens.toLocaleString('en-AU')} output tokens ({row.calls} calls).</li>)}</ul> : <Notice>No inference usage recorded this month.</Notice>}</section>
 </>;
}
