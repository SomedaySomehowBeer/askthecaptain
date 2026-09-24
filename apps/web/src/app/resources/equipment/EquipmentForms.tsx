'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';
import { createEquipment, updateEquipment, type Outcome } from './actions.ts';
import type { Equipment } from './types.ts';

type Said = { tone: 'error' | 'done' | 'locked'; text: string } | null;
const notConfirmed = 'Captain could not confirm whether that was saved. Reload the list to see what it holds before changing anything; a second item with the same name cannot be created.';

/** Submit once, keep what was typed when refused, and show a change only after the API confirms
 *  it by re-reading the page. Nothing is updated optimistically. An unconfirmed or stale result
 *  locks the form until the list is reloaded, so an outdated revision is never sent again. */
function useCatalogueSave(save: (form: FormData) => Promise<Outcome<Equipment>>, done: (value: Equipment, form: HTMLFormElement) => string) {
	const router = useRouter();
	const [pending, start] = useTransition();
	const [said, setSaid] = useState<Said>(null);
	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault(); if (pending || said?.tone === 'locked') return;
		const form = event.currentTarget; const data = new FormData(form, (event.nativeEvent as SubmitEvent).submitter);
		setSaid(null);
		start(async () => {
			let result: Outcome<Equipment>;
			try { result = await save(data); } catch { setSaid({ tone: 'locked', text: notConfirmed }); return; }
			if (!result.ok) {
				setSaid(result.kind === 'uncertain' ? { tone: 'locked', text: notConfirmed } : result.kind === 'stale' ? { tone: 'locked', text: result.error } : { tone: 'error', text: result.error });
				return;
			}
			setSaid({ tone: 'done', text: done(result.value, form) });
			router.refresh();
		});
	}
	return { pending, locked: pending || said?.tone === 'locked', said, submit };
}

const Message = ({ said }: { said: Said }) => !said ? null : said.tone === 'locked' ? (
	<p className="form__error" role="alert">{said.text} <button type="button" className="button button--secondary button--small" onClick={() => window.location.reload()}>Reload the list</button></p>
) : <p className={said.tone === 'error' ? 'form__error' : 'muted'} role={said.tone === 'error' ? 'alert' : 'status'}>{said.text}</p>;

export function AddEquipmentForm() {
	const { pending, locked, said, submit } = useCatalogueSave(createEquipment, (value, form) => { form.reset(); return `Added “${value.name}”.`; });
	return (
		<form className="form" onSubmit={submit} method="post" aria-busy={pending || undefined}>
			<div className="row equipment-form__row">
				<div className="field"><label htmlFor="equipment-name">Add equipment</label>
					<input id="equipment-name" name="name" type="text" required maxLength={100} placeholder="Canning line" disabled={locked} /></div>
				<button className="button button--primary" type="submit" disabled={locked}>{pending ? 'Adding…' : 'Add equipment'}</button>
			</div>
			<Message said={said} />
		</form>
	);
}

/** Rename, archive or restore one item against the revision shown on this page. */
export function EquipmentControls({ equipment }: { equipment: Equipment }) {
	const { pending, locked, said, submit } = useCatalogueSave(updateEquipment, (value) => value.archivedAt ? `Archived “${value.name}”.` : `Saved “${value.name}”.`);
	return (
		<div className="stack equipment-controls">
			{equipment.archivedAt ? null : (
				<details className="disclosure"><summary>Rename</summary>
					<form className="form" onSubmit={submit} method="post" aria-busy={pending || undefined}>
						<input type="hidden" name="id" value={equipment.id} /><input type="hidden" name="expectedRevision" value={equipment.revision} /><input type="hidden" name="change" value="rename" />
						<div className="row equipment-form__row">
							<div className="field"><label htmlFor={`rename-${equipment.id}`}>New name</label>
								<input id={`rename-${equipment.id}`} name="name" type="text" required maxLength={100} defaultValue={equipment.name} disabled={locked} /></div>
							<button className="button button--secondary" type="submit" disabled={locked}>{pending ? 'Saving…' : 'Rename'}</button>
						</div>
					</form>
				</details>
			)}
			<form onSubmit={submit} method="post" aria-busy={pending || undefined}>
				<input type="hidden" name="id" value={equipment.id} /><input type="hidden" name="expectedRevision" value={equipment.revision} />
				<input type="hidden" name="change" value={equipment.archivedAt ? 'restore' : 'archive'} />
				<button className="button button--ghost button--small" type="submit" disabled={locked}>
					{pending ? 'Saving…' : equipment.archivedAt ? `Restore ${equipment.name}` : `Archive ${equipment.name}`}
				</button>
			</form>
			<Message said={said} />
		</div>
	);
}
