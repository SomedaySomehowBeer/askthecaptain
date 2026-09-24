'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { createTag, renameTag, type TagResult } from './actions.ts';

type Said = { tone: 'error' | 'done'; text: string } | null;
const uncertain = 'Captain could not confirm whether that was saved. Refresh the list to check before trying again.';

/** Submit once, keep what was typed when the API refuses, and show the change only after the API
 *  confirms it (the page is re-read, never updated optimistically). */
function useTagSave(save: (form: FormData) => Promise<TagResult>, done: (result: { tag: { name: string } }, form: HTMLFormElement) => string) {
	const router = useRouter();
	const [pending, start] = useTransition();
	const [said, setSaid] = useState<Said>(null);
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault(); if (pending) return;
		const form = event.currentTarget; const data = new FormData(form);
		setSaid(null);
		start(async () => {
			let result: TagResult;
			try { result = await save(data); } catch { setSaid({ tone: 'error', text: uncertain }); return; }
			if ('error' in result) { setSaid({ tone: 'error', text: result.error }); return; }
			setSaid({ tone: 'done', text: done(result, form) });
			router.refresh();
		});
	}
	return { pending, said, submit };
}

const Message = ({ said }: { said: Said }) => said
	? <p className={said.tone === 'error' ? 'form__error' : 'muted'} role={said.tone === 'error' ? 'alert' : 'status'}>{said.text}</p> : null;

export function CreateTagForm() {
	const { pending, said, submit } = useTagSave(createTag, (result, form) => { form.reset(); return `Added “${result.tag.name}”.`; });
	return (
		<form className="form" onSubmit={submit} method="post" aria-busy={pending || undefined}>
			<div className="row work-tag-form">
				<div className="field"><label htmlFor="new-tag-name">New tag</label>
					<input id="new-tag-name" name="name" type="text" required maxLength={60} placeholder="Production" disabled={pending} /></div>
				<button className="button button--primary" type="submit" disabled={pending}>{pending ? 'Adding…' : 'Add tag'}</button>
			</div>
			<Message said={said} />
		</form>
	);
}

/** Renaming changes the one shared label: every task that carries it shows the new name. */
export function RenameTagForm({ id, name }: { id: string; name: string }) {
	const { pending, said, submit } = useTagSave(renameTag, (result) => `Renamed to “${result.tag.name}” on every task that has it.`);
	return (
		<form className="form" onSubmit={submit} method="post" aria-busy={pending || undefined}>
			<input type="hidden" name="id" value={id} />
			<p className="muted">This renames the tag for everyone. Tasks keep it; they show the new name.</p>
			<div className="row work-tag-form">
				<div className="field"><label htmlFor={`rename-${id}`}>New name for “{name}”</label>
					<input id={`rename-${id}`} name="name" type="text" required maxLength={60} defaultValue={name} disabled={pending} /></div>
				<button className="button button--secondary" type="submit" disabled={pending}>{pending ? 'Renaming…' : 'Rename for everyone'}</button>
			</div>
			<Message said={said} />
		</form>
	);
}
