'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { sendMessage } from '../../app/chat/actions.ts';
import { chatStorage as tabStorage, clearSend, loadSend, nextSendState, purgeOtherUsers, saveSend, sendSeen, type PendingSend } from '../../app/chat/pending.ts';
import { chatLimits, normaliseBody, type Message } from '../../app/chat/types.ts';
import type { Viewer } from './viewer-types.ts';

const codePoints = (text: string) => [...text].length;
const clock = (ms: number, timezone: string) => new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));

/** The message box for one conversation, shared by the full thread and the item panels (plan §1–2). Each conversation
 *  has at most one pending send, stored in this tab before the request goes out, under the same key wherever the
 *  composer appears, so a send started in a panel blocks the thread's composer too until it is confirmed.
 *  - rate-limited: not processed; the text stays editable and keeps its id; nothing resends on its own.
 *  - uncertain (or found mid-send after a reload): locked; "Try again" resends the same id and text, or discard it.
 *  - refused: editable with the reason; "Send as new message" uses a new id, or discard it.
 *  The record clears on confirmation, when its id appears in the conversation (`seenIds`), on discard or on lost access. */
export function Composer({ viewer, conversationId, title, source, seenIds, halted = false, onSent, onGone, onScope, onSignedOut }: {
	viewer: Viewer; conversationId: string; title: string; source: 'thread' | 'panel'; seenIds: ReadonlySet<string>;
	/** The surface stopped (expired session or another organisation active, noticed anywhere on it): the draft and any
	 *  pending record stay as they are, and nothing can be sent, retried or discarded until sign-in or reload. */
	halted?: boolean;
	onSent(message: Message): void; onGone(): void; onScope(message: string): void; onSignedOut(): void;
}) {
	const scope = viewer.scope;
	const id = useId();
	const [draft, setDraft] = useState('');
	const [pending, setPending] = useState<PendingSend | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [kept, setKept] = useState(true);
	const [signedOut, setSignedOut] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const box = useRef<HTMLTextAreaElement>(null);
	/** The view this composer currently belongs to. A send's result is applied to the screen only while it is still
	 *  the same person, organisation and conversation and the composer is mounted; its stored record (keyed by that
	 *  scope) is still updated, so it restores correctly where it belongs. */
	const viewKey = `${scope.userId}:${scope.organisationId}:${conversationId}`.toLowerCase();
	const live = useRef<string | null>(null);

	useEffect(() => {
		live.current = viewKey;
		const storage = tabStorage();
		// Another person's records never stay in this tab once someone else is signed in here.
		purgeOtherUsers(storage, scope.userId);
		const restored = loadSend(storage, scope, conversationId);
		// A record found mid-send is already mapped to `uncertain` by the decoder; a malformed one was discarded unseen.
		if (restored.state === 'found') { setPending(restored.record); setDraft(restored.record.body); }
		else { setPending(null); setDraft(''); }
		setProblem(null); setSignedOut(false);
		return () => { live.current = null; };
	}, [viewKey, scope, conversationId]);
	useEffect(() => {
		if (pending && sendSeen(pending, seenIds)) { clearSend(tabStorage(), scope, conversationId); setPending(null); setDraft(''); setProblem(null); }
	}, [pending, seenIds, scope, conversationId]);
	useEffect(() => {
		if (pending?.state !== 'rate-limited' || pending.retryAt === null) return;
		const wait = pending.retryAt - Date.now();
		if (wait <= 0) return;
		const timer = window.setTimeout(() => setNow(Date.now()), wait + 50);
		return () => window.clearTimeout(timer);
	}, [pending]);

	const stopped = signedOut || halted;
	const locked = pending?.state === 'uncertain' || sending || stopped;
	const waiting = pending?.state === 'rate-limited' && pending.retryAt !== null && pending.retryAt > now;
	const length = codePoints(draft.trim());

	/** Store (always, under this send's own scope) and show (only while the same view is live). */
	function remember(record: PendingSend, key: string) {
		const stored = saveSend(tabStorage(), scope, conversationId, record);
		if (live.current !== key) return;
		if (!stored) setKept(false);
		setPending(record);
	}
	function forget(key: string) { clearSend(tabStorage(), scope, conversationId); if (live.current === key) setPending(null); }

	/** Send `text` with `messageId`: the record is stored first, then the request, then the table's transition. */
	async function send(messageId: string, text: string) {
		if (stopped) return;
		const body = normaliseBody(text);
		if (typeof body !== 'string') { setProblem(body.error); return; }
		const key = viewKey;
		const record: PendingSend = { id: messageId, body, state: 'sending', retryAt: null, code: null };
		remember(record, key);
		setSending(true); setProblem(null);
		try {
			const result = await sendMessage({ scope, conversationId, id: messageId, body });
			if (!result.ok && result.kind === 'signed-out') {
				// The session expired: the stored record (with its id) stays for this person and organisation, so after
				// signing in again it restores locked and retries with the same id. Only explicit sign-out purges it.
				if (live.current === key) { setSignedOut(true); setProblem(result.error); onSignedOut(); }
				return;
			}
			const next = nextSendState(record, result, Date.now());
			if (next === 'clear') {
				forget(key);
				if (live.current !== key) return;
				if (result.ok) { setDraft(''); onSent(result.value); box.current?.focus(); }
				else if (result.kind === 'gone') onGone();
				return;
			}
			remember(next, key);
			if (live.current !== key) return;
			setNow(Date.now());
			if (!result.ok) {
				if (result.kind === 'wrong-scope') onScope(result.error);
				setProblem(result.error);
			}
		} catch {
			// The request may or may not have reached Captain: keep it locked, exactly like an uncertain result.
			remember({ ...record, state: 'uncertain' }, key);
			if (live.current === key) setProblem('Captain could not confirm whether this was sent.');
		} finally { if (live.current === key) setSending(false); }
	}
	function submit() {
		if (locked || waiting) return;
		// Only a new send takes a new id; a rate-limited or not-sent message keeps its id (it was never processed).
		const same = pending && (pending.state === 'rate-limited' || pending.state === 'sending');
		void send(same ? pending.id : crypto.randomUUID(), draft);
	}

	const stateLine = pending?.state === 'uncertain' ? 'Captain could not confirm whether this was sent. Try again to resend the same message, or discard it.'
		: pending?.state === 'rate-limited' ? (waiting ? `Too many messages just now. You can send this at ${clock(pending.retryAt!, viewer.timezone)}; nothing was sent.` : 'You can send this now; nothing was sent before.')
		: pending?.state === 'refused' ? (problem ?? 'Captain could not send this message. Change it, send it as a new message, or discard it.')
		: null;

	return <form className={`chat-compose chat-compose--${source}`} aria-label={`Message ${title}`} onSubmit={event => { event.preventDefault(); submit(); }}>
		<label className="visually-hidden" htmlFor={id}>Message {title}</label>
		<textarea ref={box} id={id} value={draft} rows={2} placeholder={`Message ${title}…`} readOnly={locked} aria-describedby={stateLine || problem ? `${id}-state` : undefined}
			onChange={event => { setDraft(event.target.value); setProblem(null); }}
			onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit(); } }} />
		{stateLine || (problem && pending?.state !== 'refused') ? <p id={`${id}-state`} className={pending?.state === 'uncertain' || problem ? 'form__error' : 'muted'} role="status">{stateLine ?? problem}</p> : null}
		{!kept ? <p className="muted">This browser could not keep a copy of unsent messages, so a reload may lose one that is waiting.</p> : null}
		<div className="chat-compose__tools">
			{length > chatLimits.bodyMaxCodePoints - 200 ? <span className={length > chatLimits.bodyMaxCodePoints ? 'form__error' : 'muted'}>{length} / {chatLimits.bodyMaxCodePoints}</span> : null}
			{pending?.state === 'uncertain' ? <>
				<button type="button" className="button button--secondary" disabled={sending || stopped} onClick={() => void send(pending.id, pending.body)}>Try again</button>
				<button type="button" className="button button--ghost" disabled={sending || stopped} onClick={() => { forget(viewKey); setDraft(''); setProblem(null); }}>Discard</button>
			</> : pending?.state === 'refused' ? <>
				<button type="button" className="button button--secondary" disabled={sending || stopped} onClick={() => void send(crypto.randomUUID(), draft)}>Send as new message</button>
				<button type="button" className="button button--ghost" disabled={sending || stopped} onClick={() => { forget(viewKey); setDraft(''); setProblem(null); }}>Discard</button>
			</> : null}
			{pending?.state !== 'uncertain' && pending?.state !== 'refused'
				? <button type="submit" className="chat-compose__send" aria-label="Send" disabled={sending || waiting || stopped || length === 0}>{sending ? '…' : '→'}</button> : null}
		</div>
	</form>;
}
