'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { createWorkTask } from '../actions.ts';
import { WorkPicker } from '../WorkPicker.tsx';
import { workTaskHref } from '../types.ts';

export type OwnerOption = { id: string; label: string };
export type ProjectOption = { id: string; label: string };

/** A new task in words: what, who owns it, where and by when. Values stay in the form when a save
 *  fails; a saved task opens where it lives. */
export function NewTaskForm({ owners, ownerId, projects, projectId }: { owners: OwnerOption[]; ownerId: string; projects: ProjectOption[] | null; projectId: string }) {
	const router = useRouter();
	const [error, setError] = useState<string | null>(null);
	const [locked, setLocked] = useState(false);
	const [pending, startTransition] = useTransition();
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault(); if (pending || locked) return;
		const data = new FormData(event.currentTarget);
		setError(null);
		startTransition(async () => {
			try {
				const result = await createWorkTask(data);
				if ('error' in result) { setError(result.error); setLocked(!!result.locked); }
				else router.push(workTaskHref(result) ?? '/work');
			} catch { setLocked(true); setError('The save could not be confirmed. Check Work before trying again.'); }
		});
	}
	return (
		<form className="form" onSubmit={submit} method="post" aria-busy={pending || undefined}>
			<fieldset disabled={pending || locked} className="work-new__fields">
				<div className="field"><label htmlFor="new-task-title">Task</label>
					<input id="new-task-title" name="title" type="text" required maxLength={200} autoFocus placeholder="Confirm packaging slot" /></div>
				<div className="row">
					<div className="field work-new__half"><label htmlFor="new-task-owner">Owner</label>
						<select id="new-task-owner" name="ownerId" defaultValue={ownerId} required>{owners.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></div>
					<div className="field work-new__half"><label htmlFor="new-task-due">Due</label><input id="new-task-due" name="due" type="date" /></div>
				</div>
				<WorkPicker initial={projectId} choices={projects}/><div className="field"><label htmlFor="new-task-body">Details</label><textarea id="new-task-body" name="body" maxLength={5000} /></div>
			</fieldset>
			{error ? <p className="form__error" role="alert">{error}{locked?<a href="/work"> Check Work</a>:null}</p> : null}
			<div className="row">
				<button className="button button--primary" type="submit" disabled={pending || locked}>{pending ? 'Adding…' : 'Add task'}</button>
				<Link className="button button--ghost" href="/work">Cancel</Link>
			</div>
		</form>
	);
}
