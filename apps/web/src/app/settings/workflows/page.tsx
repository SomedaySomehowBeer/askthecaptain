import { Suspense } from 'react';
import Link from 'next/link';
import { RunControl } from './RunControl.tsx';
import type { Metadata } from 'next';
import { Notice } from '../../../components/Notice.tsx';
import { Page, requireCurrent } from '../../../components/Page.tsx';
import { api, load, type OfferedWorkflow, type WorkflowCatalog, type WorkflowRun, type WorkflowRunDetail } from '../../../lib/api.ts';
import { shortDate } from '../../../lib/dates.ts';
import { WorkflowForm } from './WorkflowForm.tsx';
import { triggerWords } from './steps.ts';
import { WorkflowSteps } from './WorkflowSteps.tsx';
import { isRetiredWorkflow } from './retired.ts';

export const metadata: Metadata = { title: 'Workflows' };

function stepNote(step: WorkflowRunDetail['steps'][number]) {
 const output = step.output;
 if (!output || typeof output !== 'object') return null;
 if (step.state === 'waiting' && 'wakeAt' in output && typeof output.wakeAt === 'string' && Number.isFinite(Date.parse(output.wakeAt)))
  return `Next check: ${new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(output.wakeAt))} UTC.`;
 if (step.state === 'succeeded' && 'skipped' in output && typeof output.skipped === 'string') return `No action: ${output.skipped.slice(0, 500)}`;
 return 'note' in output && typeof output.note === 'string' ? output.note : null;
}

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
	const me = await requireCurrent('/settings/workflows');
 return <Suspense fallback={<Page title="Workflows"><p role="status">Reading workflows and activity…</p></Page>}><WorkflowContent me={me} searchParams={searchParams} /></Suspense>;
}
async function WorkflowContent({ me, searchParams }: { me: Awaited<ReturnType<typeof requireCurrent>>; searchParams: Promise<{ run?: string }> }) {
	const org = me.organisation.organisationId; const canManage = me.organisation.role !== 'member';
	const [offered, runs] = await Promise.all([
		load(() => api<{ workflows: OfferedWorkflow[]; catalog?: WorkflowCatalog }>(`/v1/organisations/${org}/workflows`, { token: me.token })),
		load(() => api<{ runs: WorkflowRun[] }>(`/v1/organisations/${org}/workflows/runs?limit=20`, { token: me.token }))
	]);
 const selected = (await searchParams).run;
 const detail = selected ? await load(() => api<WorkflowRunDetail>(`/v1/organisations/${org}/workflows/runs/${encodeURIComponent(selected)}`, { token: me.token })) : null;
	const catalog: WorkflowCatalog = offered.ok ? offered.value.catalog ?? {} : {};
	const definitionOf = (key: string) => offered.ok ? offered.value.workflows.find((w) => w.definition.key === key)?.definition ?? null : null;
	return (
		<Page title="Workflows" lede="What Captain does for you, and on whose say-so. Turning one on is the authorisation: it acts in your name and can do nothing you could not.">
			{!offered.ok ? <Notice tone="failed" title="The workflows could not be read.">{offered.error.message}</Notice> : offered.value.workflows.map((item) => isRetiredWorkflow(item.definition.key, item.definition.version) ? (
				<section className="card card--inset" key={item.definition.key} aria-labelledby={`wf-${item.definition.key}`}>
					<div className="row row--between"><h2 id={`wf-${item.definition.key}`}>{item.definition.name}</h2><span className="chip">retired</span></div>
					<p className="secondary">This workflow belonged to the retired personal assistant and can no longer be turned on or run. Its past activity is still listed below.</p>
				</section>
			) : (
				<section className="card" key={item.definition.key} aria-labelledby={`wf-${item.definition.key}`}>
					<div className="row row--between">
						<h2 id={`wf-${item.definition.key}`}>{item.definition.name}</h2>
						<span className="chip">{item.enablement?.enabled ? 'on' : 'off'}</span>
					</div>
					<p className="secondary">{item.definition.description}</p>
					<p className="muted">Runs {item.definition.triggers.map(triggerWords).join(', and ')}.
						{item.enablement?.enabled && item.enablement.enabledByName ? ` On since ${shortDate(item.enablement.updatedAt.slice(0, 10))}, in ${item.enablement.enabledByName}'s name.` : ''}</p>
					<details className="disclosure" open><summary>What it does, step by step</summary><WorkflowSteps definition={item.definition} catalog={catalog} /></details>
					{item.unmet.length > 0 ? <Notice tone={item.enablement?.enabled ? 'attention' : 'quiet'} title={item.enablement?.enabled ? 'This workflow cannot run right now.' : 'Not ready to turn on yet.'}>It needs {item.unmet.map((u) => u.words).join(' and ')}.</Notice> : null}
					{item.runnerProblem ? <Notice tone="quiet" title="Not ready to run.">{item.runnerProblem}</Notice> : null}
     <WorkflowForm offered={item} canManage={canManage} />
     {canManage && item.enablement?.enabled ? <RunControl id={item.definition.key} action="run" disabled={Boolean(item.runnerProblem) || item.unmet.length > 0} /> : null}
				</section>
			))}
			<section className="card" aria-labelledby="activity">
				<h2 id="activity">Activity</h2>
				{!runs.ok ? <Notice tone="failed">{runs.error.message}</Notice> : runs.value.runs.length === 0 ? (
					<p className="muted">No runs yet. Turn on a ready workflow to begin. Each run and its steps will appear here.</p>
				) : (
					<ul className="bare">{runs.value.runs.map((run) => (
						<li key={run.id} className="line"><span><Link href={`/settings/workflows?run=${run.id}`}><strong>{run.definitionKey}</strong></Link><br /><span className="muted">{run.state}{run.reason ? `: ${run.reason}` : ''}</span></span><span className="muted">{shortDate(run.createdAt.slice(0, 10))}</span></li>
					))}</ul>
				)}
   {detail ? !detail.ok ? <Notice tone="failed" title="The run could not be read.">{detail.error.message}</Notice> : <section aria-labelledby="run-detail">
     <h3 id="run-detail">{detail.value.definitionKey} · version {detail.value.definitionVersion}</h3>
     <p>{detail.value.state}{detail.value.reason ? `: ${detail.value.reason}` : ''}</p>
     <RunSteps detail={detail.value} definition={definitionOf(detail.value.definitionKey)} catalog={catalog} />
     {detail.value.steps.length ? <details className="disclosure"><summary>Every step as it ran</summary><ol>{detail.value.steps.map(step => <li key={step.path}><strong>{step.key}</strong>{step.itemIndex === null ? '' : ` · item ${step.itemIndex + 1}`} — {step.state}{step.error ? <p className="form__error">{step.error}</p> : null}{stepNote(step) ? <p className="muted">{stepNote(step)}</p> : null}</li>)}</ol></details> : <p className="muted">No steps have started yet.</p>}
     {isRetiredWorkflow(detail.value.definitionKey, detail.value.definitionVersion) ? <p className="muted">This workflow is retired: its run can be cancelled but not resumed.</p> : null}
     {canManage ? <div className="row">{detail.value.state === 'paused' && !isRetiredWorkflow(detail.value.definitionKey, detail.value.definitionVersion) ? <RunControl id={detail.value.id} action="resume" /> : null}{!['succeeded', 'failed', 'cancelled'].includes(detail.value.state) ? <RunControl id={detail.value.id} action="cancel" /> : null}</div> : <p className="muted">Owners and admins resume or cancel runs.</p>}
    </section> : null}
			</section>
		</Page>
	);
}

/** The run laid over its workflow's steps: how far each got, counting loop items. The steps shown are
 *  the current definition; a run pinned to an older version says so rather than pretending. */
function RunSteps({ detail, definition, catalog }: { detail: WorkflowRunDetail; definition: OfferedWorkflow['definition'] | null; catalog: WorkflowCatalog }) {
	if (!definition) return <p className="muted">This run's workflow is no longer offered, so its steps are listed below as they ran.</p>;
	return (<>
		{definition.version !== detail.definitionVersion ? <p className="muted">This run used version {detail.definitionVersion} of the workflow; the steps drawn here are version {definition.version}, so some may not line up.</p> : null}
		<WorkflowSteps definition={definition} catalog={catalog} run={detail.steps} />
	</>);
}
