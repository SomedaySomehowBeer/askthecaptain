'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { addLink, addParticipants, getConversation, removeLink, removeParticipant, renameConversation } from '../../actions.ts';
import { chatStorage as tabStorage, clearSend } from '../../pending.ts';
import { chatWords, type ChatResult } from '../../results.ts';
import { chatLimits, normaliseTitle, type ChatMember, type ConversationDetail, type LinkKind } from '../../types.ts';
import { WorkPicker } from '../../../work/WorkPicker.tsx';
import { AccessLost } from '../../../../components/chat/AccessLost.tsx';
import { canModerate, type Viewer } from '../../../../components/chat/viewer-types.ts';

type Outcome = { tone: 'note' | 'error'; text: string } | null;

/** Title, people and links. Each change carries the revision it was based on. A stale change shows what is there now
 *  and keeps the person's choices; an uncertain one re-reads the conversation and says whether it happened; nothing
 *  retries on its own (plan §2). */
export function DetailsForms({ viewer, detail: initial, members }: { viewer: Viewer; detail: ConversationDetail; members: ChatMember[] | null }) {
	const router = useRouter();
	const [detail, setDetail] = useState(initial);
	const [gone, setGone] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
	/** A change that may or may not have landed and could not be read back: every change here stays locked, and
	 *  "Check again" only reads, until the conversation shows whether it holds. */
	const [unresolved, setUnresolved] = useState<{ section: string; holds: (d: ConversationDetail) => boolean; done: string; left?: () => void } | null>(null);
	/** Rate limited: no change from this page before this time. */
	const [waitUntil, setWaitUntil] = useState<number | null>(null);
	useEffect(() => {
		if (waitUntil === null) return;
		const timer = window.setTimeout(() => setWaitUntil(null), Math.max(0, waitUntil - Date.now()) + 50);
		return () => window.clearTimeout(timer);
	}, [waitUntil]);
	const [signedOut, setSignedOut] = useState(false);
	/** Another person or organisation is now active in this browser: nothing more is sent from this page. */
	const [scopeLost, setScopeLost] = useState<string | null>(null);
	const say = (section: string, outcome: Outcome) => setOutcomes(o => ({ ...o, [section]: outcome }));
	const scope = viewer.scope, conversationId = detail.id;
	const me = viewer.userId.toLowerCase();
	const blocked = busy !== null || unresolved !== null || waitUntil !== null || signedOut || scopeLost !== null;

	/** Read only: does the intended state hold? `left` runs when the intent was to leave and the conversation is now
	 *  unavailable to this person, which is exactly what leaving looks like. */
	async function settle(section: string, holds: (d: ConversationDetail) => boolean, done: string, left?: () => void): Promise<boolean> {
		const read = await getConversation(scope, conversationId).catch(() => null);
		if (read?.ok) {
			setDetail(read.value); setUnresolved(null);
			if (holds(read.value)) { say(section, { tone: 'note', text: done }); router.refresh(); return true; }
			say(section, { tone: 'error', text: 'Not saved. Check the details below and try again when you are ready.' }); return false;
		}
		if (read?.kind === 'gone') { setUnresolved(null); if (left) left(); else setGone(true); return !!left; }
		// Stopped with the outcome still unknown: the intent stays, so Check again works after sign-in or reload.
		if (read?.kind === 'signed-out') { setUnresolved({ section, holds, done, left }); setSignedOut(true); say(section, { tone: 'error', text: read.error }); return false; }
		if (read?.kind === 'wrong-scope') { setUnresolved({ section, holds, done, left }); setScopeLost(read.error); say(section, { tone: 'error', text: read.error }); return false; }
		setUnresolved({ section, holds, done, left });
		say(section, { tone: 'error', text: 'Captain could not confirm whether that was saved. Check your connection, then check again.' }); return false;
	}

	/** A read that answered expired session or another organisation stops the page (drafts kept); gone shows access
	 *  lost. Returns whether it was one of those. Any other failed read locks nothing. */
	function terminal(read: Awaited<ReturnType<typeof getConversation>> | null): boolean {
		if (!read || read.ok) return false;
		if (read.kind === 'gone') { setGone(true); return true; }
		if (read.kind === 'signed-out') { setSignedOut(true); return true; }
		if (read.kind === 'wrong-scope') { setScopeLost(read.error); return true; }
		return false;
	}

	/** Run one change and report it in its section. `holds` says whether the intended state is there in a re-read. */
	async function change<T>(section: string, run: (revision: number) => Promise<ChatResult<T>>, holds: (d: ConversationDetail) => boolean, done: string, left?: () => void): Promise<boolean> {
		if (blocked) return false;
		setBusy(section); say(section, null);
		try {
			const result = await run(detail.revision).catch(() => null);
			if (result?.ok) {
				if (left) { left(); return true; }
				// The change is confirmed; the read-back only refreshes what is shown (or stops the page if it must).
				const read = await getConversation(scope, conversationId).catch(() => null);
				if (read?.ok) setDetail(read.value); else if (terminal(read) && read?.kind === 'gone') return true;
				say(section, { tone: 'note', text: done }); router.refresh(); return true;
			}
			// A request that threw may have reached Captain: exactly like an uncertain result.
			if (result === null || result.kind === 'uncertain') return settle(section, holds, done, left);
			switch (result.kind) {
				case 'stale': {
					const read = await getConversation(scope, conversationId).catch(() => null);
					if (read?.ok) setDetail(read.value); else terminal(read);
					say(section, { tone: 'error', text: `${chatWords.stale_revision} Your choices are kept.` }); return false;
				}
				case 'gone': setGone(true); return false;
				case 'rate-limited': {
					const seconds = Math.max(1, result.retryAfter ?? 1);
					setWaitUntil(Date.now() + seconds * 1000);
					say(section, { tone: 'error', text: `Too many changes just now. Try again in ${seconds} seconds; nothing was changed.` }); return false;
				}
				case 'signed-out': setSignedOut(true); say(section, { tone: 'error', text: result.error }); return false;
				case 'wrong-scope': setScopeLost(result.error); say(section, { tone: 'error', text: result.error }); return false;
				case 'refused': say(section, { tone: 'error', text: chatWords[result.code] ?? result.error }); return false;
				default: say(section, { tone: 'error', text: result.error }); return false;
			}
		} finally { setBusy(null); }
	}
	async function checkAgain() {
		if (!unresolved || busy !== null || signedOut || scopeLost !== null) return;
		setBusy(unresolved.section);
		try { await settle(unresolved.section, unresolved.holds, unresolved.done, unresolved.left); } finally { setBusy(null); }
	}

	if (gone) return <AccessLost scope={scope} conversationId={conversationId} />;
	const participants = new Set(detail.participants.map(p => p.userId.toLowerCase()));
	const candidates = (members ?? []).filter(m => !participants.has(m.userId.toLowerCase()));
	const room = chatLimits.participantsMax - detail.participants.length;
	const moderator = canModerate(viewer);
	const status = (section: string) => { const o = outcomes[section]; return o ? <p className={o.tone === 'error' ? 'form__error' : 'muted'} role={o.tone === 'error' ? 'alert' : 'status'}>{o.text}</p> : null; };

	return <div className="chat-details stack">
		<p><Link href={`/chat/${conversationId}`}>Back to the conversation</Link></p>
		{unresolved ? <div className="card notice notice--attention" role="alert">
			<p>Captain has not confirmed your last change. Nothing else can be changed here until it has checked.</p>
			<button type="button" className="button button--secondary" disabled={busy !== null || signedOut || scopeLost !== null} onClick={() => void checkAgain()}>{busy !== null ? 'Checking…' : 'Check again'}</button>
		</div> : null}
		{scopeLost ? <div className="card notice notice--attention" role="alert"><p>{scopeLost}</p>
			<button type="button" className="button button--secondary" onClick={() => window.location.reload()}>Reload</button></div> : null}
		{signedOut ? <div className="card notice notice--attention" role="alert"><p>Your session has ended, so nothing here can be changed.</p>
			<a className="button button--secondary" href={`/sign-in?return_to=${encodeURIComponent(`/chat/${conversationId}/details`)}`}>Sign in again</a></div> : null}
		<TitleForm title={detail.title} busy={busy === 'title'} locked={blocked} onSave={title => change('title',
			revision => renameConversation({ scope, conversationId, expectedRevision: revision, title }), d => d.title === title, 'Title saved.')}>{status('title')}</TitleForm>

		<section className="card chat-details__section" aria-labelledby="people-heading">
			<h2 id="people-heading">People <span className="muted">({detail.participants.length} of {chatLimits.participantsMax})</span></h2>
			<ul className="bare chat-details__people">
				{detail.participants.map(p => <li key={p.userId} className="line">
					<span>{p.name}{p.userId.toLowerCase() === me ? ' (you)' : ''}</span>
					{p.userId.toLowerCase() === me
						? <button type="button" className="button button--ghost" disabled={blocked} onClick={() => void change('people',
							revision => removeParticipant({ scope, conversationId, userId: p.userId, expectedRevision: revision }),
							d => !d.participants.some(x => x.userId.toLowerCase() === me), 'You left the conversation.',
							() => { clearSend(tabStorage(), scope, conversationId); router.push('/chat'); })}>Leave conversation</button>
						: moderator ? <button type="button" className="button button--ghost" disabled={blocked} onClick={() => void change('people',
							revision => removeParticipant({ scope, conversationId, userId: p.userId, expectedRevision: revision }),
							d => !d.participants.some(x => x.userId.toLowerCase() === p.userId.toLowerCase()), `${p.name} was removed.`)}>Remove</button> : null}
				</li>)}
			</ul>
			{status('people')}
		</section>

		<AddPeople candidates={candidates} members={members} room={room} busy={busy === 'add'} locked={blocked} onAdd={ids => change('add',
			revision => addParticipants({ scope, conversationId, expectedRevision: revision, userIds: ids }),
			d => ids.every(id => d.participants.some(p => p.userId.toLowerCase() === id.toLowerCase())), ids.length === 1 ? 'Added.' : `${ids.length} people added.`)}>{status('add')}</AddPeople>

		<section className="card chat-details__section" aria-labelledby="links-heading">
			<h2 id="links-heading">Linked work <span className="muted">({detail.links.length} of {chatLimits.linksMax})</span></h2>
			{detail.links.length === 0 ? <p className="muted">Not linked to any task or project.</p> : <ul className="bare">
				{detail.links.map(link => <li key={link.id} className="line">
					<Link href={link.kind === 'task' ? `/work/tasks/${link.targetId}` : `/work/projects/${link.targetId}`}>{link.kind === 'task' ? 'Task' : 'Project'}: {link.title}</Link>
					<button type="button" className="button button--ghost" disabled={blocked} onClick={() => void change('links',
						revision => removeLink({ scope, conversationId, linkId: link.id, expectedRevision: revision }),
						d => !d.links.some(x => x.id === link.id), 'Link removed.')}>Remove</button>
				</li>)}
			</ul>}
			{detail.links.length < chatLimits.linksMax ? <AddLink busy={busy === 'links'} locked={blocked} onAdd={(kind, targetId) => change('links',
				revision => addLink({ scope, conversationId, expectedRevision: revision, kind, targetId }),
				d => d.links.some(x => x.kind === kind && x.targetId.toLowerCase() === targetId.toLowerCase()), 'Linked.')} />
				: <p className="muted">This conversation has the most links it can hold. Remove one to add another.</p>}
			{status('links')}
		</section>
	</div>;
}

/** Each form keeps its own choices across stale, rate-limited and unresolved results; `locked` blocks every change on
 *  the page (one in flight, one unresolved, or a rate-limit wait) while keeping the choices visible. */
function TitleForm({ title, busy, locked, onSave, children }: { title: string; busy: boolean; locked: boolean; onSave(title: string): Promise<boolean>; children: React.ReactNode }) {
	const [draft, setDraft] = useState(title);
	const [problem, setProblem] = useState<string | null>(null);
	return <form className="card chat-details__section form" aria-labelledby="title-heading" onSubmit={event => {
		event.preventDefault();
		if (locked) return;
		const next = normaliseTitle(draft);
		if (typeof next !== 'string') { setProblem(next.error); return; }
		setProblem(null); void onSave(next);
	}}>
		<h2 id="title-heading">Title</h2>
		<div className="field"><label htmlFor="conversation-title">Conversation title</label>
			<input id="conversation-title" value={draft} maxLength={chatLimits.titleMax} required readOnly={locked} onChange={event => setDraft(event.target.value)} /></div>
		{problem ? <p className="form__error" role="alert">{problem}</p> : null}
		<div className="row"><button type="submit" className="button button--primary" disabled={locked || draft.trim() === title}>{busy ? 'Saving…' : 'Save title'}</button></div>
		{children}
	</form>;
}

function AddPeople({ candidates, members, room, busy, locked, onAdd, children }: { candidates: ChatMember[]; members: ChatMember[] | null; room: number; busy: boolean; locked: boolean; onAdd(ids: string[]): Promise<boolean>; children: React.ReactNode }) {
	const [picked, setChosen] = useState<string[]>([]);
	// Someone chosen who has since joined (or left the organisation) drops out of the choice.
	const chosen = picked.filter(id => candidates.some(m => m.userId === id));
	const limit = Math.min(chatLimits.addBatchMax, room);
	const full = chosen.length >= limit;
	return <form className="card chat-details__section form" aria-labelledby="add-heading" onSubmit={event => { event.preventDefault(); if (chosen.length && !locked) void onAdd(chosen).then(ok => { if (ok) setChosen([]); }); }}>
		<h2 id="add-heading">Add people</h2>
		{members === null ? <p className="form__error" role="alert">The member list could not be read. Reload this page to add people.</p>
			: room <= 0 ? <p className="muted">This conversation has 50 people, the most it can hold.</p>
			: candidates.length === 0 ? <p className="muted">Everyone in the organisation is already here.</p>
			: <>
				<p className="secondary">People you add see the whole conversation, including everything said before they joined.</p>
				<fieldset className="chat-details__choices" disabled={locked}>
					<legend className="visually-hidden">People to add</legend>
					{candidates.map(m => <label key={m.userId} className="chat-choice">
						<input type="checkbox" checked={chosen.includes(m.userId)} disabled={!chosen.includes(m.userId) && full}
							onChange={event => setChosen(c => event.target.checked ? [...c, m.userId] : c.filter(x => x !== m.userId))} />{m.name}
					</label>)}
				</fieldset>
				{full ? <p className="muted">You can add up to {limit} {limit === 1 ? 'person' : 'people'} at a time here.</p> : null}
				<div className="row"><button type="submit" className="button button--primary" disabled={locked || chosen.length === 0}>{busy ? 'Adding…' : chosen.length > 1 ? `Add ${chosen.length} people` : 'Add'}</button></div>
			</>}
		{children}
	</form>;
}

function AddLink({ busy, locked, onAdd }: { busy: boolean; locked: boolean; onAdd(kind: LinkKind, targetId: string): Promise<boolean> }) {
	const [kind, setKind] = useState<LinkKind>('task');
	const [target, setTarget] = useState('');
	const [round, setRound] = useState(0);
	return <form className="form chat-details__add-link" onSubmit={event => { event.preventDefault(); if (target && !locked) void onAdd(kind, target).then(ok => { if (ok) { setTarget(''); setRound(r => r + 1); } }); }}>
		<fieldset className="row" disabled={locked}><legend className="visually-hidden">Link a task or a project</legend>
			<label className="chat-choice"><input type="radio" name="link-kind" checked={kind === 'task'} onChange={() => { setKind('task'); setTarget(''); }} />Task</label>
			<label className="chat-choice"><input type="radio" name="link-kind" checked={kind === 'project'} onChange={() => { setKind('project'); setTarget(''); }} />Project</label>
		</fieldset>
		<WorkPicker key={`${kind}-${round}`} kind={kind === 'task' ? 'tasks' : 'projects'} name="targetId" empty={kind === 'task' ? 'Choose a task' : 'Choose a project'} disabled={locked} onChange={setTarget} />
		<div className="row"><button type="submit" className="button button--secondary" disabled={locked || !target}>{busy ? 'Linking…' : 'Link'}</button></div>
	</form>;
}
