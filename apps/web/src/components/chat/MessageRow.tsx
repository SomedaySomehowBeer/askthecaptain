'use client';
import { useEffect, useState } from 'react';
import { initialsOf } from '../../lib/nav.ts';
import { chatLimits, type Message, type Pin } from '../../app/chat/types.ts';
import { timeLabel } from './days.ts';
import { linkify } from './linkify.ts';
import { MessageMenu, type MenuAction } from './MessageMenu.tsx';
import type { MessageActions, RowOutcome } from './feed-state.ts';
import type { Viewer } from './viewer-types.ts';

/** Message text as text, with http(s) addresses as links that open elsewhere and carry no referrer. */
export function Body({ text }: { text: string }) {
	return <>{linkify(text).map((part, i) => part.kind === 'text' ? <span key={i}>{part.text}</span>
		: <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow">{part.text}</a>)}</>;
}

/** Edit and delete act on an exact snapshot of the message (`base`): the version the person opened, or after a stale
 *  answer the exact version that answer's re-read returned and the row showed them. A newer version arriving by poll
 *  is never adopted silently: the write carries the snapshot's revision, so it is refused as stale and shown. */
type Mode = { kind: 'view' } | { kind: 'edit'; draft: string; base: Message } | { kind: 'confirm-delete'; base: Message };

/** One message: avatar, author ("Former member" only when the attribution was deleted), time, "edited", body or
 *  "Message deleted", and its actions. Edits and deletes happen inline in the row; an uncertain result locks the row
 *  while it is re-read, and nothing retries on its own. */
export function MessageRow({ message: m, viewer, moderator, pin, alternate, actions, highlighted, halted = false }: {
	message: Message; viewer: Viewer; moderator: boolean; pin: Pin | null; alternate: boolean; actions: MessageActions; highlighted: boolean;
	/** The surface stopped (expired session or another organisation): drafts stay, no write or check can start. */
	halted?: boolean;
}) {
	const [mode, setMode] = useState<Mode>({ kind: 'view' });
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<{ tone: 'note' | 'error'; text: string; current?: string | null } | null>(null);
	/** A write whose outcome is not known yet: the row stays locked, keeping its draft, until a read settles it. */
	const [unresolved, setUnresolved] = useState<{ check: () => Promise<RowOutcome>; after: (o: RowOutcome) => void } | null>(null);
	/** Rate limited: no write from this row before this time. */
	const [waitUntil, setWaitUntil] = useState<number | null>(null);
	useEffect(() => {
		if (waitUntil === null) return;
		const timer = window.setTimeout(() => setWaitUntil(null), Math.max(0, waitUntil - Date.now()) + 50);
		return () => window.clearTimeout(timer);
	}, [waitUntil]);
	const locked = busy || unresolved !== null || waitUntil !== null || halted;
	/** Leaving an edit or a delete confirmation is local, but not while its outcome is unknown or the surface stopped. */
	const held = busy || unresolved !== null || halted;
	const name = m.authorName ?? 'Former member';
	const deleted = m.deletedAt !== null;
	const mine = m.authorId !== null && m.authorId.toLowerCase() === viewer.userId.toLowerCase();
	const time = timeLabel(m.createdAt, viewer.timezone);
	const available: MenuAction[] = deleted ? [] : [pin ? 'unpin' : 'pin', ...(mine ? ['edit' as const] : []), ...(mine || moderator ? ['delete' as const] : [])];

	/** Run a write (or a read-only check of an unresolved one). The row unlocks only once the outcome is known. */
	async function run(work: () => Promise<RowOutcome>, after: (o: RowOutcome) => void = () => {}) {
		if (busy || halted) return;
		setBusy(true); setStatus(null);
		try {
			// The actions map lost requests to uncertain and reads never throw; this is a last resort and never replays `work`.
			const outcome = await work().catch((): RowOutcome => ({ ok: false, error: 'Something went wrong in this page. Reload it to see the message as it is now.' }));
			setStatus(outcome.ok ? (outcome.note ? { tone: 'note', text: outcome.note } : null) : { tone: 'error', text: outcome.error, current: outcome.current });
			if (!outcome.ok && outcome.unresolved) { setUnresolved({ check: outcome.unresolved, after }); return; }
			setUnresolved(null);
			if (!outcome.ok && outcome.waitUntil) setWaitUntil(outcome.waitUntil);
			after(outcome);
		} finally { setBusy(false); }
	}
	function write(work: () => Promise<RowOutcome>, after?: (o: RowOutcome) => void) { if (!locked) void run(work, after); }
	function choose(action: MenuAction) {
		if (action === 'edit') { setMode({ kind: 'edit', draft: m.body ?? '', base: m }); setStatus(null); }
		else if (action === 'delete') { setMode({ kind: 'confirm-delete', base: m }); setStatus(null); }
		else if (action === 'pin') write(() => actions.pin(m.id));
		else if (pin) write(() => actions.unpin(pin));
	}

	return <li id={`message-${m.id}`} data-seq={m.seq} className={`chat-message${alternate ? ' chat-message--alt' : ''}${highlighted ? ' chat-message--found' : ''}`} aria-busy={busy || undefined}>
		<span className="chat-avatar" aria-hidden="true">{m.authorName ? initialsOf(m.authorName, '') : '–'}</span>
		<div className="chat-message__body">
			<div className="chat-message__meta">
				<strong>{name}</strong>
				<time dateTime={m.createdAt}>{time}</time>
				{m.editedAt && !deleted ? <span className="chat-message__edited">edited</span> : null}
				{pin && !deleted ? <span className="chat-message__pinned">Pinned</span> : null}
				<MessageMenu label={`Actions for ${name}’s message at ${time}`} actions={mode.kind === 'view' && !locked ? available : []} busy={locked} onAction={choose} />
			</div>
			{deleted && !unresolved ? <p className="chat-message__deleted">Message deleted</p>
				: mode.kind === 'edit' ? <form className="chat-edit" onSubmit={event => {
					event.preventDefault();
					// Sent against the snapshot. A stale answer rebinds the snapshot only to the exact version its re-read
					// returned (shown as "Current text"); if that read failed, the old snapshot stays, so the next save is
					// refused again rather than guessing. The draft is never replaced.
					const base = mode.base;
					write(() => actions.edit(base, mode.draft), o => {
						if (o.ok) setMode({ kind: 'view' });
						else if (o.stale && o.latest) { const latest = o.latest; setMode(now => now.kind === 'edit' ? { ...now, base: latest } : now); }
					});
				}}>
					{m.revision !== mode.base.revision ? <p className="chat-edit__current"><span className="muted">Changed since you started editing:</span> <Body text={m.body ?? ''} /></p>
						: status?.current !== undefined && status.current !== null ? <p className="chat-edit__current"><span className="muted">Current text:</span> <Body text={status.current} /></p> : null}
					<label className="visually-hidden" htmlFor={`edit-${m.id}`}>Edit your message</label>
					<textarea id={`edit-${m.id}`} value={mode.draft} rows={3} maxLength={chatLimits.bodyMaxCodePoints * 2} readOnly={locked} autoFocus
						onChange={event => { const draft = event.target.value; setMode(now => now.kind === 'edit' ? { ...now, draft } : now); }}
						onKeyDown={event => { if (event.key === 'Escape' && !held) { setMode({ kind: 'view' }); setStatus(null); } }} />
					<div className="row">
						<button type="submit" className="button button--primary" disabled={locked}>{busy ? 'Saving…' : 'Save'}</button>
						<button type="button" className="button button--ghost" disabled={held} onClick={() => { setMode({ kind: 'view' }); setStatus(null); }}>Cancel</button>
					</div>
				</form>
				: <p className="chat-message__text"><Body text={m.body ?? ''} /></p>}
			{mode.kind === 'confirm-delete' && (!deleted || unresolved) ? <div className="chat-confirm" role="group" aria-label="Delete this message">
				<p>Delete this message? Everyone here will see “Message deleted”.</p>
				{m.revision !== mode.base.revision ? <p className="chat-edit__current"><span className="muted">Changed since you chose Delete:</span> <Body text={m.body ?? ''} /></p> : null}
				<div className="row">
					<button type="button" className="button button--danger" disabled={locked} onClick={() => {
						const base = mode.base;
						write(() => actions.remove(base), o => {
							if (o.ok) setMode({ kind: 'view' });
							else if (o.stale && o.latest) { const latest = o.latest; setMode(now => now.kind === 'confirm-delete' ? { ...now, base: latest } : now); }
						});
					}}>{busy ? 'Deleting…' : 'Delete'}</button>
					<button type="button" className="button button--ghost" disabled={held} onClick={() => { setMode({ kind: 'view' }); setStatus(null); }}>Cancel</button>
				</div>
			</div> : null}
			{busy ? <p className="muted" role="status">Checking…</p> : null}
			{status ? <p className={status.tone === 'error' ? 'form__error' : 'muted'} role={status.tone === 'error' ? 'alert' : 'status'}>{status.text}</p> : null}
			{unresolved && !busy ? <div className="row">
				<button type="button" className="button button--secondary" disabled={halted} onClick={() => void run(unresolved.check, unresolved.after)}>Check again</button>
			</div> : null}
		</div>
	</li>;
}
