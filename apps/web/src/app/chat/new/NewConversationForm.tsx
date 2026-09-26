'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { WorkPicker } from '../../work/WorkPicker.tsx';
import type { Choice } from '../../work/records.ts';
import { createConversation } from '../actions.ts';
import { chatStorage, clearCreate, loadCreate, nextCreateState, purgeOtherUsers, saveCreate, sortLinks, type PendingCreate } from '../pending.ts';
import type { ChatResult } from '../results.ts';
import { chatLimits, normaliseTitle, type ChatMember, type ChatScope, type ConversationDetail, type LinkKind } from '../types.ts';

export type ChosenLink = { kind: LinkKind; targetId: string; label: string };
type Phase =
	| { kind: 'editing' }
	| { kind: 'sending' }
	| { kind: 'uncertain' }                       // may have been created: locked, same id and payload retried
	| { kind: 'rate-limited'; retryAt: number }   // not processed: editable, same id
	| { kind: 'refused'; code: string }           // not created: editable; id_unavailable needs a new id
	| { kind: 'stopped'; reason: 'signed-out' | 'scope' } // nothing sent; no more writes until sign-in or reload
	| { kind: 'done' };

const newId = () => crypto.randomUUID();
const refusalWords: Record<string, string> = {
	participant_unavailable: 'Someone you chose is no longer an active member of this organisation. Nothing was created; check the people and try again.',
	link_target_unavailable: 'A task or project you chose is no longer available. Nothing was created; remove it and try again.',
	participant_limit: 'A new conversation can include up to 49 other people. Nothing was created; remove someone and try again.',
	link_limit: 'A conversation can link up to 10 tasks and projects. Nothing was created; remove a link and try again.',
	id_unavailable: 'This new conversation could not use its reserved identity, so nothing was created. Start again to keep these details.',
	not_sent: 'This conversation was not sent before your session or organisation changed, so nothing was created. Check the details, then start it.'
};
const stoppedWords = {
	'signed-out': 'Your session has ended, so nothing was sent. Sign in again to start this conversation; its details are kept in this tab.',
	scope: 'This page was opened for a different sign-in or organisation than the one now active in this browser, so nothing was sent. Reload to continue in the current organisation; these details stay with the organisation they were started in.'
} as const;

/** A new conversation: title, people and optional links. Its id and exact payload are kept in this tab before the
 *  request leaves, so a reload or an unclear answer can only ever repeat the same create (web plan §1, §2). */
export function NewConversationForm({ scope, members, initialLink, tasks, projects }: { scope: ChatScope; members: ChatMember[] | null; initialLink: ChosenLink | null; tasks: Choice[] | null; projects: Choice[] | null }) {
	const router = useRouter();
	const [id, setId] = useState<string>(newId);
	const [title, setTitle] = useState('');
	const [people, setPeople] = useState<string[]>([]);
	const [links, setLinks] = useState<ChosenLink[]>(initialLink ? [initialLink] : []);
	const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
	const [error, setError] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [pickerKey, setPickerKey] = useState(0);
	const [now, setNow] = useState(() => Date.now());
	const pickers = useRef<HTMLDivElement>(null);
	const known = useRef(new Map<string, string>([...(tasks ?? []).map((t) => [`task:${t.id}`, t.label] as const), ...(projects ?? []).map((p) => [`project:${p.id}`, p.label] as const)]));

	/** The person and organisation this form is showing, while mounted. A create's answer changes the screen only while
	 *  it is still the same; its stored record, keyed by the scope it was sent under, is updated either way. */
	const viewKey = `${scope.userId}:${scope.organisationId}`.toLowerCase();
	const live = useRef<string | null>(null);
	useEffect(() => { live.current = viewKey; return () => { live.current = null; }; }, [viewKey]);

	// Restore an unconfirmed create from this tab, once. Records of anyone else signed in here before are removed.
	useEffect(() => {
		const storage = chatStorage();
		purgeOtherUsers(storage, scope.userId);
		const restored = loadCreate(storage, scope);
		if (restored.state === 'unavailable') { setNote('This browser is not keeping a copy of new conversations, so if the connection drops, check your conversations before trying again.'); return; }
		if (restored.state === 'invalid') { setNote('A new conversation left unfinished in this tab could not be read, so it was discarded.'); return; }
		if (restored.state !== 'found') return;
		const r = restored.record;
		setId(r.id); setTitle(r.title); setPeople(r.participantIds);
		setLinks(r.links.map((l) => ({ ...l, label: known.current.get(`${l.kind}:${l.targetId}`) ?? (l.kind === 'task' ? 'A task you chose' : 'A project you chose') })));
		apply(r);
	}, [scope.userId, scope.organisationId]);

	// A rate-limited create becomes sendable again when its wait is over.
	useEffect(() => {
		if (phase.kind !== 'rate-limited') return;
		const wait = phase.retryAt - Date.now();
		if (wait <= 0) return;
		const timer = setTimeout(() => setNow(Date.now()), wait + 50);
		return () => clearTimeout(timer);
	}, [phase]);

	function apply(r: PendingCreate) {
		if (r.state === 'uncertain' || r.state === 'sending') { setPhase({ kind: 'uncertain' }); setError('Captain could not confirm whether this conversation was created. Try again: it will not be created twice.'); }
		else if (r.state === 'rate-limited') { setPhase({ kind: 'rate-limited', retryAt: r.retryAt ?? Date.now() }); setError(`Captain is receiving too many requests from you. Nothing was created; try again after ${new Date(r.retryAt ?? Date.now()).toLocaleTimeString()} (your local time).`); }
		else { const code = r.code ?? 'refused'; setPhase({ kind: 'refused', code }); setError(refusalWords[code] ?? 'Captain could not create this conversation. Nothing was created; check the details and try again.'); }
	}

	const locked = phase.kind === 'sending' || phase.kind === 'uncertain' || phase.kind === 'stopped' || phase.kind === 'done';
	const needsNewId = phase.kind === 'refused' && phase.code === 'id_unavailable';
	const waiting = phase.kind === 'rate-limited' && phase.retryAt > now;
	const peopleFull = people.length >= chatLimits.createOthersMax;
	const linksFull = links.length >= chatLimits.linksMax;

	function togglePerson(userId: string, on: boolean) {
		setPeople((current) => on ? (current.includes(userId) || current.length >= chatLimits.createOthersMax ? current : [...current, userId].sort()) : current.filter((p) => p !== userId));
	}
	function addLink(kind: LinkKind, targetId: string) {
		if (!targetId) return;
		const option = pickers.current?.querySelector<HTMLSelectElement>(`select[name="chat-link-${kind}"]`)?.selectedOptions[0];
		const label = option?.textContent?.trim() || known.current.get(`${kind}:${targetId}`) || (kind === 'task' ? 'Chosen task' : 'Chosen project');
		known.current.set(`${kind}:${targetId.toLowerCase()}`, label);
		setLinks((current) => current.some((l) => l.kind === kind && l.targetId === targetId.toLowerCase()) || current.length >= chatLimits.linksMax ? current : [...current, { kind, targetId: targetId.toLowerCase(), label }]);
		setPickerKey((k) => k + 1);
	}

	async function send(record: PendingCreate, prior: PendingCreate | null) {
		if (phase.kind === 'stopped' || live.current !== viewKey) return;
		const key = viewKey;
		const storage = chatStorage();
		if (!saveCreate(storage, scope, record) && storage) setNote('This browser did not keep a copy of this conversation. If the connection drops, check your conversations before trying again.');
		setPhase({ kind: 'sending' }); setError(null);
		let result: ChatResult<ConversationDetail>;
		try { result = await createConversation({ scope, id: record.id, title: record.title, participantIds: record.participantIds, links: record.links }); }
		catch { result = { ok: false, kind: 'uncertain', retryAfter: null, requestId: null, error: 'Captain could not confirm whether this conversation was created.' }; }
		const shown = live.current === key;
		if (result.ok) { clearCreate(storage, scope); if (shown) { setPhase({ kind: 'done' }); router.replace(`/chat/${result.value.id}`); } return; }
		if (result.kind === 'signed-out' || result.kind === 'wrong-scope') {
			// Nothing was sent. The record keeps its id and payload under the scope it belongs to (hidden while another
			// is active), and this form sends nothing more until the person signs in again or reloads.
			saveCreate(storage, scope, prior ?? { ...record, state: 'refused', retryAt: null, code: 'not_sent' });
			if (shown) { setPhase({ kind: 'stopped', reason: result.kind === 'signed-out' ? 'signed-out' : 'scope' }); setError(stoppedWords[result.kind === 'signed-out' ? 'signed-out' : 'scope']); }
			return;
		}
		if (result.kind === 'not-sent') {
			// Nothing was sent (the session could not be checked, or the input was refused here): keep what the tab had.
			if (prior) { saveCreate(storage, scope, prior); if (shown) apply(prior); } else { clearCreate(storage, scope); if (shown) setPhase({ kind: 'editing' }); }
			if (shown) setError(result.error);
			return;
		}
		const next = nextCreateState(record, result, Date.now());
		if (next === 'clear') { clearCreate(storage, scope); if (shown) { setPhase({ kind: 'editing' }); setError(result.error); } return; }
		saveCreate(storage, scope, next);
		if (!shown) return;
		setNow(Date.now());
		apply(next);
		if (next.state === 'refused' && result.kind === 'refused' && !refusalWords[next.code ?? '']) setError(result.error);
		if (result.requestId && next.state !== 'rate-limited') setError((e) => `${e ?? result.error} Reference: ${result.requestId}`);
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (locked || waiting || needsNewId) return;
		const checked = normaliseTitle(title);
		if (typeof checked !== 'string') { setError(checked.error); return; }
		if (people.length > chatLimits.createOthersMax) { setError('A new conversation can include up to 49 other people.'); return; }
		if (links.length > chatLimits.linksMax) { setError('A conversation can link up to 10 tasks and projects.'); return; }
		const stored = loadCreate(chatStorage(), scope);
		const prior = stored.state === 'found' && stored.record.id === id ? stored.record : null;
		void send({ id, title: checked, participantIds: [...people].sort(), links: sortLinks(links), state: 'sending', retryAt: null, code: null }, prior);
	}

	function retry() {
		const stored = loadCreate(chatStorage(), scope);
		if (stored.state === 'found' && stored.record.id === id) { void send({ ...stored.record, state: 'sending', retryAt: null, code: null }, stored.record); return; }
		// The tab could not keep the record: resend what is on screen with the same id.
		const checked = normaliseTitle(title);
		if (typeof checked !== 'string') { setError(checked.error); return; }
		void send({ id, title: checked, participantIds: [...people].sort(), links: sortLinks(links), state: 'sending', retryAt: null, code: null }, null);
	}

	function startAgain() {
		if (phase.kind === 'stopped') return;
		clearCreate(chatStorage(), scope);
		setId(newId()); setPhase({ kind: 'editing' }); setError(null);
	}

	const busy = phase.kind === 'sending';
	return (
		<form className="form" onSubmit={submit} aria-busy={busy || undefined}>
			<fieldset disabled={locked} className="chat-new__fields">
				<div className="field"><label htmlFor="chat-new-title">Title</label>
					<input id="chat-new-title" name="title" type="text" required maxLength={chatLimits.titleMax} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Packaging for the Thursday run" /></div>

				<fieldset className="chat-new__set">
					<legend>People <span className="muted">You + {people.length} (up to 49 others)</span></legend>
					{members === null ? <p className="muted">Members could not be read. Only you will be in this conversation for now.</p>
						: members.length === 0 ? <p className="muted">Nobody else is an active member of this organisation yet.</p>
						: <div className="chat-new-people">{members.map((m) => {
							const on = people.includes(m.userId);
							return <label key={m.userId} className="chat-new-person"><input type="checkbox" checked={on} disabled={!on && peopleFull} onChange={(e) => togglePerson(m.userId, e.target.checked)} />{m.name}</label>;
						})}</div>}
					{people.some((p) => !members?.some((m) => m.userId === p)) ? <p className="muted">Someone chosen earlier is not in the member list now; they stay chosen, and Captain will say if they cannot be added.</p> : null}
					{peopleFull ? <p className="muted">That is the most people a new conversation can start with.</p> : null}
					<p className="muted">Everyone added can read the whole conversation.</p>
				</fieldset>

				<fieldset className="chat-new__set">
					<legend>Linked work <span className="muted">(optional; up to 10)</span></legend>
					{links.length ? <ul className="bare chat-new-links" aria-label="Linked tasks and projects">{links.map((l) => (
						<li key={`${l.kind}:${l.targetId}`} className={`chip chat-new-link${l.kind === 'project' ? ' chip--project' : ''}`}>
							<span>{l.kind === 'task' ? 'Task' : 'Project'}: {l.label}</span>
							<button type="button" className="chat-new-link__remove" aria-label={`Remove ${l.label}`} onClick={() => setLinks((current) => current.filter((x) => !(x.kind === l.kind && x.targetId === l.targetId)))}>×</button>
						</li>
					))}</ul> : <p className="muted">Not linked to any task or project.</p>}
					<div ref={pickers} key={pickerKey}>
						<WorkPicker kind="tasks" name="chat-link-task" initial="" choices={tasks} empty={linksFull ? 'Link limit reached' : 'Link a task…'} disabled={locked || linksFull} onChange={(value) => addLink('task', value)} />
						<WorkPicker kind="projects" name="chat-link-project" initial="" choices={projects} empty={linksFull ? 'Link limit reached' : 'Link a project…'} disabled={locked || linksFull} onChange={(value) => addLink('project', value)} />
					</div>
				</fieldset>
			</fieldset>

			{note ? <p className="muted" role="status">{note}</p> : null}
			{error ? <p className="form__error" role="alert">{error}</p> : null}
			{/* Each control has its own key: React must never reuse one of these buttons as another. A click re-renders
			    synchronously, before the browser's default action, so a reused "Start again" button that had become the
			    submit button would submit the form in the same click. The non-submit handlers also cancel any default. */}
			<div className="row">
				{phase.kind === 'stopped' ? (phase.reason === 'signed-out'
					? <a key="sign-in" className="button button--primary" href={`/sign-in?return_to=${encodeURIComponent('/chat/new')}`}>Sign in again</a>
					: <button key="reload" className="button button--primary" type="button" onClick={(e) => { e.preventDefault(); window.location.reload(); }}>Reload</button>)
				: phase.kind === 'uncertain' ? <>
					<button key="retry" className="button button--primary" type="button" onClick={(e) => { e.preventDefault(); retry(); }}>Try again</button>
					<Link key="check" className="button button--ghost" href="/chat">Check your conversations</Link>
				</> : needsNewId ? <>
					<button key="start-again" className="button button--primary" type="button" onClick={(e) => { e.preventDefault(); startAgain(); }}>Start again</button>
					<Link key="cancel-again" className="button button--ghost" href="/chat">Cancel</Link>
				</> : <>
					<button key="start" className="button button--primary" type="submit" disabled={busy || waiting || phase.kind === 'done'}>{busy ? 'Starting…' : 'Start conversation'}</button>
					<Link key="cancel" className="button button--ghost" href="/chat">Cancel</Link>
				</>}
			</div>
		</form>
	);
}
