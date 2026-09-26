'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import type { CreateScope } from './pending-create.ts';
import { readView, reconcileFilterSave, sameFilter, savedHref, type SavedFilter } from './saved-views.ts';
import { SaveViewForm } from './SaveViewForm.tsx';
import { checkView, updateView, type ViewResult } from './view-actions.ts';

type Said = { tone: 'error' | 'done' | 'quiet'; text: string } | null;
type Phase = 'idle' | 'uncertain' | 'stale' | 'gone';

/** "Changed from Name". The draft is saved against `base`, the revision it began from; a change made
 *  elsewhere meanwhile is shown beside the draft and nothing is written until the person chooses.
 *  `current*` props come from the page's fresh read, so both filters are always the server's words. */
export function DraftBar({ viewId, name, base, draft, draftWords, currentRevision, currentWords, unchanged, scope }: {
	viewId: string; name: string; base: number; draft: SavedFilter; draftWords: string;
	currentRevision: number; currentWords: string; unchanged: boolean; scope: CreateScope;
}) {
	const router = useRouter();
	const [pending, start] = useTransition();
	const sending = useRef(false);
	const [phase, setPhase] = useState<Phase>('idle');
	const [said, setSaid] = useState<Said>(null);
	// The expectedRevision of the last filter save actually sent: `base` for Save changes, or the revision an explicit
	// Replace was sent against. Uncertain retries and checks use this, never a different revision.
	const [sentRevision, setSentRevision] = useState(base);
	const changedElsewhere = currentRevision !== base;
	const conflict = phase === 'stale' || changedElsewhere;
	const locked = pending || phase === 'uncertain';

	function saved() {
		setPhase('idle'); setSaid({ tone: 'done', text: `Saved “${name}”.` });
		router.push(savedHref(viewId));
	}
	function settle(result: ViewResult) {
		if (result.ok) { saved(); return; }
		if (result.kind === 'stale') {
			// An earlier uncertain save that did land looks stale on retry: the stored filter is then the draft.
			const stored = result.current ? readView(result.current) : null;
			if (stored?.ok && sameFilter(stored.filter, draft)) { saved(); return; }
			setPhase('stale'); setSaid({ tone: 'error', text: `${result.error} Compare the two filters below; nothing has been overwritten.` });
			router.refresh();
			return;
		}
		if (result.kind === 'gone') { setPhase('gone'); setSaid({ tone: 'error', text: result.error }); return; }
		if (result.kind === 'uncertain') { setPhase('uncertain'); setSaid({ tone: 'error', text: `${result.error} Your draft is kept. Check whether it saved, or try again.` }); return; }
		setSaid({ tone: 'error', text: result.error });
	}
	function patch(expectedRevision: number) {
		if (sending.current) return;
		sending.current = true; setSaid(null); setSentRevision(expectedRevision);
		start(async () => {
			let result: ViewResult;
			try { result = await updateView({ id: viewId, expectedRevision, filter: draft, scope }); }
			catch { result = { ok: false, kind: 'uncertain', error: 'Captain could not confirm whether that was saved.' }; }
			sending.current = false;
			settle(result);
		});
	}
	function check() {
		if (sending.current) return;
		sending.current = true; setSaid({ tone: 'quiet', text: 'Checking…' });
		start(async () => {
			let read: Awaited<ReturnType<typeof checkView>>;
			try { read = await checkView(viewId, scope); } catch { read = { ok: false, kind: 'unreadable', error: 'The check could not be completed.' }; }
			sending.current = false;
			if (!read.ok) {
				if (read.kind === 'gone') { setPhase('gone'); setSaid({ tone: 'error', text: 'This saved view is no longer available. Save the draft as a new view to keep it.' }); }
				else setSaid({ tone: 'error', text: `${read.error} Your draft is kept; check again or try again.` });
				return;
			}
			const outcome = reconcileFilterSave(sentRevision, draft, read.view);
			if (outcome === 'saved') { saved(); return; }
			if (outcome === 'not-saved') {
				// A Replace that did not land leaves the conflict it answered; Save changes that did not land leaves the draft.
				if (sentRevision !== base) { setPhase('stale'); setSaid({ tone: 'quiet', text: 'The saved filter was not replaced. Nothing changed; compare the two filters below and choose again.' }); }
				else { setPhase('idle'); setSaid({ tone: 'quiet', text: 'The draft was not saved. Nothing changed; save it again when ready.' }); }
				return;
			}
			setPhase('stale'); setSaid({ tone: 'error', text: 'This view was changed elsewhere, and not to your draft. Compare the two filters below; nothing has been overwritten.' });
			router.refresh();
		});
	}

	return (
		<section className="card work-draft" aria-label="Unsaved changes to this view">
			<p className="work-draft__title"><strong>Changed from {name}</strong>{unchanged && !conflict ? <span className="muted"> · matches the saved filter</span> : null}</p>
			{conflict ? (
				<div className="work-draft__compare" role="group" aria-label="Saved filter and your draft">
					<p className="muted">{changedElsewhere ? 'The saved view has changed since this draft began.' : 'The saved view changed elsewhere.'}</p>
					<dl>
						<div><dt>Saved now</dt><dd>{currentWords}</dd></div>
						<div><dt>Your draft</dt><dd>{draftWords}</dd></div>
					</dl>
				</div>
			) : null}
			{said ? <p className={said.tone === 'error' ? 'form__error' : 'muted'} role={said.tone === 'error' ? 'alert' : 'status'}>{said.text}</p> : null}
			<div className="row work-draft__actions">
				{phase === 'uncertain' ? <>
					<button className="button button--primary" type="button" onClick={check} disabled={pending}>{pending ? 'Checking…' : 'Check whether it saved'}</button>
					<button className="button button--secondary" type="button" onClick={() => patch(sentRevision)} disabled={pending}>Try again</button>
				</> : phase === 'gone' ? null : phase === 'stale' ? (
					// Only after the refusal, and only against the revision now on screen.
					!changedElsewhere
						? <button className="button button--primary" type="button" disabled>Reading the saved view…</button>
						: <button className="button button--primary" type="button" onClick={() => patch(currentRevision)} disabled={locked}>{pending ? 'Saving…' : 'Replace the saved filter with my draft'}</button>
				) : (
					<button className="button button--primary" type="button" onClick={() => patch(base)} disabled={locked || unchanged}>{pending ? 'Saving…' : 'Save changes'}</button>
				)}
				<Link className="button button--ghost" href={savedHref(viewId)} aria-disabled={locked || undefined} onClick={(event) => { if (locked) event.preventDefault(); }}>Discard</Link>
			</div>
			<SaveViewForm filter={draft} words={draftWords} scope={scope} summary="Save as new view" startOpen={phase === 'gone'} />
		</section>
	);
}
