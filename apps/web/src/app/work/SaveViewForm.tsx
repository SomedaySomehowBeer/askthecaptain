'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import { clearPending, loadPending, savePending, tabStorage, type CreateScope, type PendingCreate, type StorageLike } from './pending-create.ts';
import { maxViewName, readView, sameFilter, savedHref, viewName, type SavedFilter } from './saved-views.ts';
import { checkView, createView, type ViewResult } from './view-actions.ts';

/** A create identity: generated once for a new-view draft and kept, with its exact payload, through refused, failed
 *  and uncertain saves — and, via this tab's sessionStorage, through a reload. Only an explicit "Save as a new view"
 *  makes another. */
type Identity = PendingCreate;
type Said = { tone: 'error' | 'done' | 'quiet'; text: string } | null;
type Phase = 'editing' | 'uncertain' | 'id-unavailable' | 'invalid-record' | 'wrong-scope';

function newViewId(): string {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const cannotKeep = 'Nothing was saved. This tab is not letting Captain keep the save’s identity, which it needs so a reload can never save the view twice. Allow this site to store data for the tab (private browsing or storage settings can block it), then save again.';

/** "Save this view" (or "Save as new view" from a draft): a name, the filter in words, and one create id. The id
 *  and payload are stored in this tab before they are sent; an uncertain save stays locked, here and after a reload,
 *  until a same-id retry or a read of that id settles it. It never turns into a second create by itself. */
export function SaveViewForm({ filter, words, scope, summary = 'Save this view', startOpen = false }: { filter: SavedFilter; words: string; scope: CreateScope; summary?: string; startOpen?: boolean }) {
	const router = useRouter();
	const [pending, start] = useTransition();
	const sending = useRef(false);
	const pendingId = useRef<string | null>(null);
	const storage = useRef<StorageLike | null>(null);
	const [identity, setIdentity] = useState<Identity | null>(null);
	const [phase, setPhase] = useState<Phase>('editing');
	const [said, setSaid] = useState<Said>(null);
	const [storageNote, setStorageNote] = useState<string | null>(null);
	const [restored, setRestored] = useState(false);
	const [keepOpen, setKeepOpen] = useState(false);
	// Nothing can be sent until this tab's pending record has been looked for, so a hydrating form can never send a
	// fresh id ahead of an unconfirmed one.
	const [ready, setReady] = useState(false);
	const locked = phase !== 'editing';
	const shown = locked && identity ? identity : null;

	// Restore an unconfirmed create from before a reload, and lock it until it is reconciled.
	const { userId, organisationId } = scope;
	useEffect(() => {
		storage.current = tabStorage();
		const found = loadPending(storage.current, { userId, organisationId });
		if (found.state === 'found') {
			pendingId.current = found.record.id;
			setIdentity(found.record); setPhase('uncertain'); setRestored(true);
			setSaid({ tone: 'error', text: `Captain has not confirmed whether “${found.record.name}” was saved before this page reloaded. Check whether it saved, or try again with the same details.` });
		} else if (found.state === 'invalid') {
			// Kept, and the form stays locked: an unreadable record may stand for a save that landed. Only the person
			// clears it, by choosing to start a new view after checking their saved views.
			setPhase('invalid-record');
			setSaid({ tone: 'error', text: 'This tab holds an unconfirmed save that Captain cannot read, so it may or may not have been saved. Check your saved views first; then start a new view if it is not there.' });
		}
		setReady(true);
	}, [userId, organisationId]);

	function resolved() { clearPending(storage.current, scope); setRestored(false); }

	function settle(result: ViewResult, sent: Identity, retry: boolean) {
		if (result.ok) {
			resolved();
			setSaid({ tone: 'done', text: `Saved “${sent.name}”. Opening it…` });
			router.push(savedHref(sent.id));
			return;
		}
		if (result.kind === 'uncertain') { setPhase('uncertain'); setSaid({ tone: 'error', text: `${result.error} “${sent.name}” is kept as it was sent. Check whether it saved, or try again with the same details.` }); return; }
		if (result.kind === 'id-unavailable') { setPhase('id-unavailable'); setSaid({ tone: 'error', text: result.error }); return; }
		if (result.kind === 'wrong-scope') {
			// Nothing left for the other organisation. A first attempt's record is dropped (it was never sent); an
			// unconfirmed earlier save keeps its record and lock for when this organisation is active again.
			if (!retry) resolved();
			setPhase(retry ? 'uncertain' : 'wrong-scope'); setSaid({ tone: 'error', text: result.error });
			return;
		}
		// Not sent while retrying an unconfirmed save proves nothing about the first attempt: keep it locked.
		if (retry && result.kind === 'not-sent') { setPhase('uncertain'); setSaid({ tone: 'error', text: `${result.error} “${sent.name}” is still unconfirmed and kept as it was sent.` }); return; }
		// Refused (or a first attempt not sent): nothing was created with this id. The outcome is known, so the tab
		// record goes; the name may be edited and the same id is reused for the next attempt.
		resolved(); setPhase('editing'); setSaid({ tone: 'error', text: result.error });
	}

	/** `retry` resends an identity that is already unconfirmed (and already locked); anything else is a new create. */
	function send(sent: Identity, retry: boolean) {
		if (sending.current || !ready) return;
		setKeepOpen(true);
		// Written before the request leaves, so a reload mid-save still knows this identity.
		storage.current ??= tabStorage();
		const kept = savePending(storage.current, scope, sent);
		if (!kept && !retry) {
			// A new create whose identity this tab cannot keep is not sent at all: nothing leaves, nothing is locked.
			setStorageNote(null);
			setSaid({ tone: 'error', text: cannotKeep });
			return;
		}
		// Resending the same id cannot make a second view, so an unconfirmed save may still be retried; it stays locked.
		setStorageNote(kept ? null : 'This tab still cannot keep this save across a reload. Keep this page open until Captain confirms it.');
		sending.current = true; setSaid(null);
		start(async () => {
			let result: ViewResult;
			try { result = await createView({ id: sent.id, name: sent.name, filter: sent.filter, scope: { userId, organisationId } }); }
			catch { result = { ok: false, kind: 'uncertain', error: 'Captain could not confirm whether that was saved.' }; }
			sending.current = false;
			settle(result, sent, retry);
		});
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending || locked || !ready) return;
		const name = viewName(new FormData(event.currentTarget).get('name'));
		if (typeof name !== 'string') { setSaid({ tone: 'error', text: name.error }); return; }
		pendingId.current ??= identity?.id ?? newViewId();
		const sent = { id: pendingId.current, name, filter, words };
		setIdentity(sent); send(sent, false);
	}

	function check() {
		if (!identity || sending.current) return;
		const sent = identity;
		sending.current = true; setSaid({ tone: 'quiet', text: 'Checking…' });
		start(async () => {
			let read: Awaited<ReturnType<typeof checkView>>;
			try { read = await checkView(sent.id, { userId, organisationId }); } catch { read = { ok: false, kind: 'unreadable', error: 'The check could not be completed.' }; }
			sending.current = false;
			if (read.ok) {
				const stored = readView(read.view);
				if (read.view.name === sent.name && stored.ok && sameFilter(stored.filter, sent.filter)) { settle({ ok: true, view: read.view }, sent, true); return; }
				setPhase('id-unavailable');
				setSaid({ tone: 'error', text: 'A view with this identity exists but no longer matches what you sent; it was changed elsewhere. Open your saved views to check, or save these details as a new view.' });
				return;
			}
			// Not found is not proof it will never land, so the identity stays locked for a same-id retry.
			if (read.kind === 'gone') { setSaid({ tone: 'error', text: `“${sent.name}” was not found. It may not have been saved; try again with the same details.` }); return; }
			setSaid({ tone: 'error', text: `${read.error} Nothing has been changed; check again or try again with the same details.` });
		});
	}

	/** The only way to a new create id, and the only way an unreadable tab record is cleared: the person asks for a
	 *  new view explicitly. */
	function startNew() {
		setKeepOpen(true);
		resolved();
		pendingId.current = newViewId();
		setIdentity((previous) => previous ? { ...previous, id: pendingId.current!, filter, words } : previous);
		setPhase('editing');
		setSaid({ tone: 'quiet', text: 'This will be saved as a new view with the filter on this page. Check the name, then save.' });
	}

	const fieldId = `save-view-name-${summary === 'Save this view' ? 'work' : 'draft'}`;
	return (
		<details className="disclosure work-save-view" open={startOpen || keepOpen || locked || undefined}>
			<summary>{summary}</summary>
			<form className="form" onSubmit={submit} method="post" aria-busy={pending || undefined}>
				{restored ? <p className="muted">This save began before the page reloaded. It keeps the filter it was sent with, which may differ from the list on this page.</p> : null}
				<p className="muted work-save-view__words"><span className="visually-hidden">Filter: </span>{shown ? shown.words : words}</p>
				<div className="row work-tag-form">
					<div className="field"><label htmlFor={fieldId}>View name</label>
						{shown
							? <input key={`locked-${shown.id}`} id={fieldId} name="name" type="text" readOnly aria-describedby={`${fieldId}-locked`} value={shown.name} />
							: <input key="editing" id={fieldId} name="name" type="text" required maxLength={maxViewName} placeholder="Production" autoComplete="off" disabled={pending || phase === 'invalid-record'} defaultValue={identity?.name} />}
						{shown ? <small id={`${fieldId}-locked`} className="muted">{phase === 'uncertain' ? 'Kept exactly as it was sent until Captain knows whether it saved.' : 'Kept as it was sent.'}</small> : null}
					</div>
					{locked ? null : <button className="button button--primary" type="submit" disabled={pending || !ready} aria-describedby={ready ? undefined : `${fieldId}-restoring`}>{pending ? 'Saving…' : 'Save view'}</button>}
					{ready ? null : <small id={`${fieldId}-restoring`} className="muted">Checking this tab for an unconfirmed save…</small>}
				</div>
				{said ? <p className={said.tone === 'error' ? 'form__error' : 'muted'} role={said.tone === 'error' ? 'alert' : 'status'}>{said.text}</p> : null}
				{storageNote ? <p className="muted" role="note">{storageNote}</p> : null}
				{phase === 'uncertain' ? (
					<div className="row">
						<button className="button button--secondary" type="button" onClick={check} disabled={pending}>{pending ? 'Checking…' : 'Check whether it saved'}</button>
						<button className="button button--ghost" type="button" onClick={() => identity && send(identity, true)} disabled={pending}>Try again</button>
					</div>
				) : null}
				{phase === 'wrong-scope' ? (
					<div className="row"><button className="button button--secondary" type="button" onClick={() => window.location.reload()}>Reload this page</button></div>
				) : null}
				{phase === 'invalid-record' ? (
					<div className="row">
						<a className="button button--secondary" href="/work/views">Check saved views</a>
						<button className="button button--ghost" type="button" onClick={startNew} disabled={pending}>Start a new view</button>
					</div>
				) : null}
				{phase === 'id-unavailable' ? (
					<div className="row">
						<button className="button button--secondary" type="button" onClick={startNew} disabled={pending}>Save as a new view</button>
						<a className="button button--ghost" href="/work/views">Open saved views</a>
					</div>
				) : null}
			</form>
		</details>
	);
}
