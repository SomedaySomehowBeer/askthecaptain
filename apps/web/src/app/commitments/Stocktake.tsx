import { api, load, type OfferedWorkflow } from '../../lib/api.ts';
import { Notice } from '../../components/Notice.tsx';
import type { requireCurrent } from '../../components/Page.tsx';
import { StartStocktake } from './StartStocktake.tsx';
export async function Stocktake({ me, locations }: { me: Awaited<ReturnType<typeof requireCurrent>>; locations: string[] }) {
 const result = await load(() => api<{ workflows: OfferedWorkflow[] }>(`/v1/organisations/${me.organisation.organisationId}/workflows`, { token: me.token }));
 const workflow = result.ok ? result.value.workflows.find(w => w.definition.key === 'stocktake') : undefined;
 const problem = !result.ok ? 'Stocktake availability could not be checked. Try again or check Settings → Workflows.' : !workflow ? 'Stocktake is not installed yet.' : workflow.runnerProblem
  ?? (!workflow.enablement?.enabled ? 'Turn on Stocktake in Settings → Workflows first.' : workflow.unmet.length ? `Stocktake needs ${workflow.unmet.map(u => u.words).join(' and ')}.` : null);
 return <div className="stack" aria-label="Start a stocktake"><h3>Start a stocktake</h3>
  <p>Ask for counts at one location. Low counts create reorder tasks and supplier drafts for a person to send.</p>
  {problem ? <Notice tone={!result.ok ? 'failed' : 'quiet'}>{problem} <a href="/settings/workflows">Open Workflows</a>.</Notice> : null}
  {me.organisation.role === 'member' ? <p>Only an owner or admin can start a stocktake. Everyone can enter counts below.</p> : null}
  <StartStocktake disabled={!!problem || me.organisation.role === 'member'} locations={locations} location={String(workflow?.enablement?.parameters.location ?? '')} />
 </div>;
}
