import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load } from '../../../lib/api.ts';
import { InferenceForm } from './InferenceForm.tsx';
export const metadata: Metadata = { title: 'Inference' };
type Login = { state: 'idle' | 'waiting' | 'done' | 'failed'; url: string | null; code: string | null; needsCode: boolean; note?: string | null };
type State = { role: 'owner' | 'admin' | 'member'; disabled: boolean; spritesConfigured?: boolean; login?: Login | null; runtime: { provider: 'claude' | 'codex' | 'anthropic_api'; status: 'provisioning' | 'needs_login' | 'ready' | 'failed' | 'removed'; loginHint: string | null; loginUrl: string | null; error?: string | null; spriteName?: string | null } | null; budget: { month: string; limitTokens: number; usedTokens: number }; usage: { tier: string; inputTokens: number; outputTokens: number; calls: number }[] };
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
 const { runtime, budget, usage, disabled, role, spritesConfigured = true, login = null } = result.value;
 const present = runtime && runtime.status !== 'removed'; const owner = role === 'owner';
 return <>
  {disabled ? <Notice>Inference is disabled. Ask the operator to finish configuring encryption.</Notice> : null}
  <section className="card"><h2>Subscription</h2>
   {present ? <><p>{{ claude: 'Claude', codex: 'Codex', anthropic_api: 'Anthropic API (not available)' }[runtime.provider]} · {states[runtime.status]}</p>{runtime.loginHint ? <p>{runtime.loginHint}</p> : null}
    {runtime.status === 'provisioning' ? <Notice>Captain is creating your runtime and installing the sign-in tools. This takes a few minutes the first time; refresh to check. Set the token allowance below while you wait.</Notice> : null}
    {runtime.status === 'failed' ? <Notice tone="attention" title={runtime.error?.startsWith('sprites_') || runtime.error === 'provisioning_failed' ? 'Setup failed.' : 'Verification failed.'}>{runtime.error ? <>Recorded reason: <span className="mono">{runtime.error}</span>. </> : null}{runtime.error?.startsWith('sprites_') || runtime.error === 'provisioning_failed' ? 'Press Set up subscription to try again; the same runtime is reused. If it keeps failing, tell the operator the reason above.' : 'Sign in again, then verify. If it keeps failing, disconnect the runtime and set it up again.'}</Notice> : null}
    {runtime.status === 'failed' && owner && (runtime.error?.startsWith('sprites_') || runtime.error === 'provisioning_failed') ? <InferenceForm action="create" disabled={disabled || !spritesConfigured} label="Set up subscription again"><input type="hidden" name="provider" value={runtime.provider} /></InferenceForm> : null}
    {(runtime.status === 'needs_login' || (runtime.status === 'failed' && runtime.spriteName && !(runtime.error?.startsWith('sprites_') || runtime.error === 'provisioning_failed'))) && owner ? <SignIn login={login} provider={runtime.provider} fallbackUrl={runtime.loginUrl} /> : null}
    {runtime.status === 'needs_login' && !owner ? <Notice>The owner signs in to the subscription from this page.</Notice> : null}
    {['needs_login', 'failed'].includes(runtime.status) && owner && runtime.spriteName ? <details className="disclosure"><summary>Reinstall the runtime's files</summary><p className="muted">Uploads Captain's current runtime files to the same Sprite and restarts its service. The Sprite and any finished sign-in stay; the CLIs are not reinstalled.</p><InferenceForm action="create" disabled={disabled || !spritesConfigured} label="Reinstall runtime"><input type="hidden" name="provider" value={runtime.provider} /></InferenceForm></details> : null}
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

/** Sign-in from the phone (plan §7): Sign in starts the provider's own login on the runtime; the link and, for Codex,
 *  a device code come back; Claude hands the person a code to paste here, forwarded once and never kept. */
function SignIn({ login, provider, fallbackUrl }: { login: Login | null; provider: string; fallbackUrl: string | null }) {
 const url = login?.url ?? fallbackUrl;
 if (login?.state === 'done') return <Notice title="Signed in.">Press Verify sign-in below to check the runtime answers.</Notice>;
 if (login?.state === 'waiting') return <div className="stack">
  <p>{url ? 'Open the sign-in page, sign in with the account that holds the subscription, then come back here.' : 'Starting the sign-in on your runtime. Refresh in a moment for the link.'}</p>
  {url ? <a href={url} className="button button--primary" target="_blank" rel="noreferrer">Open sign-in</a> : null}
  {login.code ? <><p className="secondary">Enter this code on the sign-in page:</p><p className="mono" style={{ fontSize: '28px', letterSpacing: '0.12em' }}>{login.code}</p></> : null}
  {login.needsCode
   ? <InferenceForm action="code" disabled={false} label="Submit code"><div className="field"><label htmlFor="inference-code">The code the sign-in page gave you</label><input id="inference-code" name="code" type="text" autoComplete="off" required minLength={6} maxLength={1024} /><p className="muted">Paste it as the sign-in page gives it; a link stuck on the end is fine.</p></div></InferenceForm>
   : <p className="secondary">When the page says you are signed in, refresh here and press Verify sign-in.</p>}
  {login.note ? <p className="muted">The runtime's sign-in said: <span className="mono">{login.note}</span></p> : null}
 </div>;
 return <div className="stack">
  {login?.note ? <p className="muted">The runtime's sign-in said: <span className="mono">{login.note}</span></p> : null}
  <Notice>{login?.state === 'failed' ? 'That sign-in did not finish. Start it again.' : `Sign in to your ${provider === 'codex' ? 'Codex' : 'Claude'} subscription from here. Nothing about the account is stored in Captain; the login stays on your runtime.`}</Notice>
  <InferenceForm action="login" disabled={false} label="Sign in" />
 </div>;
}

