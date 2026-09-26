'use client';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type FormEvent } from 'react';
import { maxViewName, reconcileRename, savedHref, viewName, type ViewScope } from './saved-views.ts';
import { checkView, deleteView, updateView, type ViewResult } from './view-actions.ts';

type Said = { tone: 'error' | 'done' | 'quiet'; text: string } | null;
type Pending = { kind: 'rename'; name: string } | { kind: 'delete' };

/** Rename and delete, each against the revision on screen. A stale or uncertain result never
 *  becomes a second write by itself; the person reloads, checks, or tries the same write again. */
export function ManageView({ viewId, name, revision, scope }: { viewId: string; name: string; revision: number; scope: ViewScope }) {
	const router = useRouter();
	const [busy, start] = useTransition();
	const sending = useRef(false);
	const [said, setSaid] = useState<Said>(null);
	const [uncertain, setUncertain] = useState<Pending | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [stale, setStale] = useState(false);
	const locked = busy || uncertain !== null || stale;

	function settle(result: ViewResult, sent: Pending) {
		if (result.ok) {
			setUncertain(null);
			if (sent.kind === 'delete') { setSaid({ tone: 'done', text: `Deleted “${name}”.` }); router.push('/work/views'); }
			else { setSaid({ tone: 'done', text: `Renamed to “${sent.name}”.` }); router.refresh(); }
			return;
		}
		if (result.kind === 'uncertain') { setUncertain(sent); setSaid({ tone: 'error', text: `${result.error} Check whether it ${sent.kind === 'delete' ? 'was deleted' : 'was renamed'}, or try again.` }); return; }
		// A retried rename whose first attempt did land comes back stale; a later revision with the sent name is that save.
		if (result.kind === 'stale' && sent.kind === 'rename' && reconcileRename(revision, sent.name, result.current) === 'saved') { settle({ ok: true, view: result.current }, sent); return; }
		if (result.kind === 'stale') { setUncertain(null); setStale(true); setSaid({ tone: 'error', text: `${result.error} Reload it to see the latest version before you ${sent.kind === 'delete' ? 'delete' : 'rename'} it.` }); return; }
		if (result.kind === 'gone') {
			setUncertain(null);
			if (sent.kind === 'delete') { setSaid({ tone: 'done', text: 'This view has already been deleted.' }); router.push('/work/views'); }
			else { setStale(true); setSaid({ tone: 'error', text: result.error }); }
			return;
		}
		// Not sent (session outage, or another organisation now active): an earlier unconfirmed change stays locked.
		if (result.kind === 'not-sent' || result.kind === 'wrong-scope') { setSaid({ tone: 'error', text: result.error }); return; }
		setUncertain(null); setSaid({ tone: 'error', text: result.error });
	}
	function send(sent: Pending) {
		if (sending.current) return;
		sending.current = true; setSaid(null);
		start(async () => {
			let result: ViewResult;
			try { result = sent.kind === 'delete' ? await deleteView({ id: viewId, expectedRevision: revision, scope }) : await updateView({ id: viewId, expectedRevision: revision, name: sent.name, scope }); }
			catch { result = { ok: false, kind: 'uncertain', error: 'Captain could not confirm the change.' }; }
			sending.current = false;
			settle(result, sent);
		});
	}
	function rename(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (locked) return;
		const next = viewName(new FormData(event.currentTarget).get('name'));
		if (typeof next !== 'string') { setSaid({ tone: 'error', text: next.error }); return; }
		if (next === name) { setSaid({ tone: 'quiet', text: 'That is already its name.' }); return; }
		send({ kind: 'rename', name: next });
	}
	function check() {
		if (!uncertain || sending.current) return;
		const sent = uncertain;
		sending.current = true; setSaid({ tone: 'quiet', text: 'Checking…' });
		start(async () => {
			let read: Awaited<ReturnType<typeof checkView>>;
			try { read = await checkView(viewId, scope); } catch { read = { ok: false, kind: 'unreadable', error: 'The check could not be completed.' }; }
			sending.current = false;
			if (!read.ok && read.kind === 'gone') { settle(sent.kind === 'delete' ? { ok: true, view: null } : { ok: false, kind: 'gone', error: 'This saved view is no longer available.' }, sent); return; }
			if (!read.ok) { setSaid({ tone: 'error', text: `${read.error} Nothing has been changed; check again or try again.` }); return; }
			if (read.view.revision === revision) { setUncertain(null); setSaid({ tone: 'quiet', text: `It was not ${sent.kind === 'delete' ? 'deleted' : 'renamed'}. Nothing changed.` }); return; }
			if (sent.kind === 'rename' && reconcileRename(revision, sent.name, read.view) === 'saved') { settle({ ok: true, view: read.view }, sent); return; }
			settle({ ok: false, kind: 'stale', current: read.view, error: 'This view was changed elsewhere.' }, sent);
		});
	}

	return (
		<details className="disclosure work-manage-view" open={uncertain !== null || stale || confirming || undefined}>
			<summary>Rename or delete this view</summary>
			<form className="form" onSubmit={rename} method="post" aria-busy={busy || undefined}>
				<div className="row work-tag-form">
					<div className="field"><label htmlFor="rename-view">Name</label>
						{uncertain?.kind === 'rename'
							? <input key="locked" id="rename-view" name="name" type="text" readOnly value={uncertain.name} />
							: <input key={`name-${revision}`} id="rename-view" name="name" type="text" required maxLength={maxViewName} defaultValue={name} disabled={locked} autoComplete="off" />}
					</div>
					<button className="button button--secondary" type="submit" disabled={locked}>{busy && !uncertain ? 'Saving…' : 'Rename'}</button>
				</div>
			</form>
			<p className="muted">Deleting a view removes only the saved filter. Tasks are not changed.</p>
			{confirming && !uncertain ? (
				<div className="row" role="group" aria-label="Confirm deletion">
					<button className="button button--danger" type="button" onClick={() => send({ kind: 'delete' })} disabled={locked}>{busy ? 'Deleting…' : `Delete “${name}”`}</button>
					<button className="button button--ghost" type="button" onClick={() => setConfirming(false)} disabled={busy}>Keep it</button>
				</div>
			) : uncertain ? null : <button className="button button--ghost" type="button" onClick={() => { setSaid(null); setConfirming(true); }} disabled={locked}>Delete view…</button>}
			{said ? <p className={said.tone === 'error' ? 'form__error' : 'muted'} role={said.tone === 'error' ? 'alert' : 'status'}>{said.text}</p> : null}
			{uncertain ? (
				<div className="row">
					<button className="button button--secondary" type="button" onClick={check} disabled={busy}>{busy ? 'Checking…' : `Check whether it ${uncertain.kind === 'delete' ? 'was deleted' : 'was renamed'}`}</button>
					<button className="button button--ghost" type="button" onClick={() => send(uncertain)} disabled={busy}>Try again</button>
				</div>
			) : null}
			{stale ? <a className="button button--secondary" href={savedHref(viewId)}>Reload this view</a> : null}
		</details>
	);
}
