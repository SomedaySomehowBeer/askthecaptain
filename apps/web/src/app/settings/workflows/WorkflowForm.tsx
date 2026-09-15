'use client';
import { useSaveForm } from '../../commitments/SaveForm.tsx';
import type { OfferedWorkflow } from '../../../lib/api.ts';
import { setWorkflow } from './actions.ts';

/** One workflow's switch and parameters. The person sees what it needs before it can run; the
 *  API refuses to enable it until those are met, and this form says so in the same words. */
export function WorkflowForm({ offered, canManage }: { offered: OfferedWorkflow; canManage: boolean }) {
	const [state, action, pending] = useSaveForm(form => setWorkflow(undefined, form));
	const { definition, enablement, unmet } = offered;
	const enabled = enablement?.enabled ?? false;
	const values = enablement?.parameters ?? {};
	const blocked = unmet.length > 0 || Boolean(offered.runnerProblem);
	return (
		<form className="form" method="post" onSubmit={action}>
			<input type="hidden" name="key" value={definition.key} />
			<input type="hidden" name="specs" value={JSON.stringify(definition.parameters)} />
			<input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
			{Object.entries(definition.parameters).map(([name, spec]) => {
				const id = `${definition.key}-${name}`; const value = values[name];
				return (
					<div className="field" key={name}>
						{spec.type === 'boolean' ? (
							<label className="row" htmlFor={id}><input id={id} type="checkbox" name={`param.${name}`} defaultChecked={typeof value === 'boolean' ? value : spec.default} disabled={!canManage} /> {spec.description}</label>
						) : spec.type === 'number' ? (<>
							<label htmlFor={id}>{spec.description}</label>
							<input id={id} type="number" name={`param.${name}`} defaultValue={typeof value === 'number' ? value : spec.default} min={spec.min} max={spec.max} disabled={!canManage} style={{ width: '8em' }} />
						</>) : (<>
							<label htmlFor={id}>{spec.description}{spec.required ? '' : ' (optional)'}</label>
							{(spec.maxLength ?? 0) > 200 ? <textarea id={id} name={`param.${name}`} defaultValue={typeof value === 'string' ? value : spec.default ?? ''} maxLength={spec.maxLength} disabled={!canManage} />
								: <input id={id} type="text" name={`param.${name}`} defaultValue={typeof value === 'string' ? value : spec.default ?? ''} maxLength={spec.maxLength} required={spec.required} disabled={!canManage} />}
						</>)}
					</div>
				);
			})}
			{state?.error ? <p className="form__error" role="alert">{state.error}</p> : null}
			{canManage ? (
				<div className="row">
					<button className={`button ${enabled ? 'button--ghost' : 'button--primary'}`} type="submit" disabled={pending || (!enabled && blocked)} aria-busy={pending || undefined}>
						{pending ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
					</button>
					{enabled ? <button className="button button--secondary" type="submit" name="intent" value="save" disabled={pending}>Save parameters</button> : null}
				</div>
			) : <p className="muted">Owners and admins turn workflows on and off.</p>}
		</form>
	);
}
