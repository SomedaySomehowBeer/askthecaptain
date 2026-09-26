'use client';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getConversation, markRead, readChanges, readMessages, readPins, setStar } from '../actions.ts';
import { applyChanges, applyMessages, applyPins, highestDisplayed, initialState, livePins, streamRows } from '../feed.ts';
import { chatStorage as tabStorage, clearSend } from '../pending.ts';
import { createPoller, type Poller } from '../poll.ts';
import { chatLimits, chatTiming, type ChangesPage, type ConversationDetail, type MessagesPage, type MessageWindow, type Pin, type PinsPage } from '../types.ts';
import { AccessLost } from '../../../components/chat/AccessLost.tsx';
import { Composer } from '../../../components/chat/Composer.tsx';
import { MessageList } from '../../../components/chat/MessageList.tsx';
import { PinsBlock } from '../../../components/chat/PinsBlock.tsx';
import { messageActions, useFeed } from '../../../components/chat/feed-state.ts';
import { canModerate, type Viewer } from '../../../components/chat/viewer-types.ts';

type Status = { kind: 'live' } | { kind: 'idle' } | { kind: 'gone' } | { kind: 'scope'; message: string } | { kind: 'signed-out' };

/** The full conversation (plan §1–2): header, every live pin, the loaded message ranges and the composer. It is the
 *  only chat surface that polls and the only one that advances the read position.
 *  - One poller per tab, one changes page per tick, only while visible and focused; a response that arrives after a
 *    hide, blur, stop or unmount applies nothing (the poller's generation guard, and `alive` for the refetches here).
 *  - Changes merge by id, keeping the higher change number; a gap loads the missing seqs, an unknown pinned message
 *    re-reads the pins, a revision change re-reads the header.
 *  - The read position moves only for messages actually displayed (not under the composer or the tab bar), at most
 *    every 15 s, while visible, focused and caught up. */
export function Thread({ viewer, detail, messages, pins }: { viewer: Viewer; detail: ConversationDetail; messages: MessagesPage; pins: PinsPage }) {
	const conversationId = detail.id, scope = viewer.scope;
	const feed = useFeed(() => initialState(messages, { latest: chatLimits.threadPage }, pins));
	const { state } = feed;
	const [conversation, setConversation] = useState(detail);
	const [status, setStatus] = useState<Status>({ kind: 'live' });
	const [delayed, setDelayed] = useState(false);
	const [lastReadSeq, setLastReadSeq] = useState(detail.lastReadSeq);
	const [highlight, setHighlight] = useState<string | null>(null);
	const [showNew, setShowNew] = useState(false);
	const [earlier, setEarlier] = useState<'idle' | 'loading' | 'failed'>('idle');
	const alive = useRef(true);
	const poller = useRef<Poller | null>(null);
	const loading = useRef({ gap: false, pins: false, detail: false });

	const onGone = useCallback(() => {
		if (!alive.current) return;
		alive.current = false; poller.current?.stop();
		clearSend(tabStorage(), scope, conversationId);
		setStatus({ kind: 'gone' });
	}, [scope, conversationId]);
	const onScope = useCallback((message: string) => { alive.current = false; poller.current?.stop(); setStatus({ kind: 'scope', message }); }, []);
	/** The session expired: stop and offer sign-in. Unsent records stay (scoped to this person and organisation) so an
	 *  uncertain send keeps its retry identity after signing back in; explicit sign-out or another person purges them. */
	const onSignedOut = useCallback(() => {
		alive.current = false; poller.current?.stop();
		setStatus({ kind: 'signed-out' });
	}, []);
	const actions = useMemo(() => messageActions({ viewer, conversationId, feed, onGone, onScope, onSignedOut }), [viewer, conversationId, feed, onGone, onScope, onSignedOut]);

	/** Load a window and merge it; every result is dropped once the thread is gone, out of scope or unmounted. */
	const loadWindow = useCallback(async (window: MessageWindow) => {
		// Nothing is read once the thread stopped (access lost, expired session, another organisation).
		if (!alive.current) return false;
		const page = await readMessages(scope, conversationId, window);
		if (!alive.current) return false;
		if (page.ok) { feed.update(s => applyMessages(s, page.value, window)); return true; }
		// Terminal answers stop the thread; any other failed read changes nothing and never locks it.
		if (page.kind === 'gone') onGone(); else if (page.kind === 'wrong-scope') onScope(page.error); else if (page.kind === 'signed-out') onSignedOut();
		return false;
	}, [scope, conversationId, feed, onGone, onScope, onSignedOut]);
	const loadGap = useCallback(async () => {
		const s = feed.ref.current;
		if (s.gapFrom === null || loading.current.gap) return;
		loading.current.gap = true;
		try { await loadWindow({ after: s.gapFrom - 1, limit: chatLimits.threadPage }); } finally { loading.current.gap = false; }
	}, [feed, loadWindow]);
	const loadNewer = useCallback(async () => {
		const tail = feed.ref.current.ranges.at(-1);
		await loadWindow(tail ? { after: tail.to, limit: chatLimits.threadPage } : { latest: chatLimits.threadPage });
	}, [feed, loadWindow]);
	const loadPins = useCallback(async () => {
		if (loading.current.pins || !alive.current) return;
		loading.current.pins = true;
		try {
			const page = await readPins(scope, conversationId);
			if (!alive.current) return;
			if (page.ok) feed.update(s => applyPins(s, page.value));
			else if (page.kind === 'gone') onGone(); else if (page.kind === 'wrong-scope') onScope(page.error); else if (page.kind === 'signed-out') onSignedOut();
		} finally { loading.current.pins = false; }
	}, [scope, conversationId, feed, onGone, onScope, onSignedOut]);
	/** The header's revision as displayed. Each changes page compares the feed's revision with it and reads the header
	 *  once (never while a read is in flight) when it is behind; a failed or outdated read is simply compared again on
	 *  the next tick, so the header catches up without a read loop. An older answer never replaces a newer header. */
	const shownRevision = useRef(detail.revision);
	const loadDetail = useCallback(async () => {
		if (loading.current.detail || !alive.current) return;
		loading.current.detail = true;
		try {
			const read = await getConversation(scope, conversationId).catch(() => null);
			if (!alive.current || !read) return;
			if (read.ok) {
				setLastReadSeq(v => Math.max(v, read.value.lastReadSeq));
				if (read.value.revision >= shownRevision.current) { shownRevision.current = read.value.revision; setConversation(read.value); }
			} else if (read.kind === 'gone') onGone(); else if (read.kind === 'wrong-scope') onScope(read.error); else if (read.kind === 'signed-out') onSignedOut();
		} finally { loading.current.detail = false; }
	}, [scope, conversationId, onGone, onScope, onSignedOut]);
	const changeHeader = useCallback((next: ConversationDetail) => {
		if (next.revision < shownRevision.current) return;
		shownRevision.current = next.revision; setConversation(next);
	}, []);

	// The poller: one per mounted thread, started at the older of the two initial snapshots.
	useEffect(() => {
		alive.current = true;
		const onPage = (page: ChangesPage): number => {
			const result = applyChanges(feed.ref.current, page);
			feed.update(() => result.state);
			setDelayed(false);
			// Polling runs again after activity: the thread is live again (and may advance the read position).
			setStatus(s => s.kind === 'idle' ? { kind: 'live' } : s);
			if (result.state.revision > shownRevision.current) void loadDetail();
			if (result.refetchPins) void loadPins();
			if (result.state.gapFrom !== null) void loadGap();
			return result.state.cursor;
		};
		const instance = createPoller({
			now: () => Date.now(),
			setTimer: (fn, ms) => window.setTimeout(fn, ms),
			clearTimer: timer => window.clearTimeout(timer as number),
			visible: () => document.visibilityState === 'visible',
			focused: () => document.hasFocus(),
			fetch: async after => {
				const page = await readChanges(scope, conversationId, after);
				if (!page.ok && (page.kind === 'unreadable' || page.kind === 'rate-limited')) setDelayed(true);
				return page;
			},
			onPage,
			onStop: reason => {
				if (reason === 'gone') onGone();
				else if (reason === 'scope') onScope('This page was opened for a different sign-in or organisation than the one now active in this browser.');
				else if (reason === 'signed-out') onSignedOut();
				else if (reason === 'idle') setStatus(s => s.kind === 'live' ? { kind: 'idle' } : s);
			},
		});
		poller.current = instance;
		instance.start(feed.ref.current.cursor);
		const visibility = () => instance.visibilityChanged();
		let lastActivity = 0;
		const activity = () => { const at = Date.now(); if (at - lastActivity > 1000) { lastActivity = at; instance.activity(); } };
		document.addEventListener('visibilitychange', visibility);
		window.addEventListener('focus', visibility); window.addEventListener('blur', visibility);
		for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) window.addEventListener(type, activity, { passive: true });
		window.addEventListener('scroll', activity, { passive: true });
		return () => {
			alive.current = false; instance.stop(); poller.current = null;
			document.removeEventListener('visibilitychange', visibility);
			window.removeEventListener('focus', visibility); window.removeEventListener('blur', visibility);
			for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) window.removeEventListener(type, activity);
			window.removeEventListener('scroll', activity);
		};
		// One poller for the life of this thread; its callbacks read the feed through the ref.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const rows = useMemo(() => streamRows(state), [state]);
	const pinsLive = useMemo(() => livePins(state), [state]);
	/** Loaded ranges that do not meet (after "Go to message" far back): the missing seqs between them, shown as such. */
	const holes = useMemo(() => state.ranges.slice(0, -1).flatMap((r, i) => r.to + 1 < state.ranges[i + 1]!.from ? [r.to] : []), [state]);
	const [filling, setFilling] = useState<{ after: number; failed: boolean } | null>(null);
	const headerBehind = state.revision > conversation.revision;
	const livePinByMessage = useMemo(() => new Map<string, Pin>(pinsLive.map(p => [p.messageId, p])), [pinsLive]);
	const seenIds = useMemo(() => new Set(state.messages.keys()), [state]);
	const hasEarlier = (state.ranges[0]?.from ?? 1) > 1;

	// Scrolling: open at the newest message (or the linked one), keep the view anchored when earlier messages load,
	// follow new messages only when already at the bottom, and scroll to a message once "Go to message" loads it.
	const nearBottom = useRef(true);
	const anchor = useRef<{ id: string; top: number } | null>(null);
	const scrollTo = useRef<string | null>(null);
	const lastTail = useRef<number>(rows.at(-1)?.seq ?? 0);
	useEffect(() => {
		const linked = /^#message-([0-9a-f-]{36})$/i.exec(window.location.hash)?.[1];
		const target = linked ? document.getElementById(`message-${linked}`) : null;
		// A linked message outside the loaded window (a panel's "Go to message") is found through its live pin.
		const pinned = linked && !target ? livePins(feed.ref.current).find(p => p.messageId === linked.toLowerCase()) : undefined;
		if (target) { target.scrollIntoView({ block: 'center' }); setHighlight(linked!); }
		else if (pinned) void goTo(pinned.messageId, pinned.message.seq);
		else window.scrollTo({ top: document.documentElement.scrollHeight });
		const track = () => { nearBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160; };
		track(); window.addEventListener('scroll', track, { passive: true });
		return () => window.removeEventListener('scroll', track);
		// Once, on arrival: where the page opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useLayoutEffect(() => {
		if (anchor.current) {
			const element = document.getElementById(`message-${anchor.current.id}`);
			if (element) window.scrollBy({ top: element.getBoundingClientRect().top - anchor.current.top });
			anchor.current = null;
		}
		if (scrollTo.current) {
			const element = document.getElementById(`message-${scrollTo.current}`);
			if (element) { element.scrollIntoView({ block: 'center' }); setHighlight(scrollTo.current); scrollTo.current = null; }
		}
		const tail = rows.at(-1)?.seq ?? 0;
		if (tail > lastTail.current) {
			if (nearBottom.current) window.scrollTo({ top: document.documentElement.scrollHeight }); else setShowNew(true);
		}
		lastTail.current = tail;
	}, [rows]);
	useEffect(() => { if (!highlight) return; const t = window.setTimeout(() => setHighlight(null), 2500); return () => window.clearTimeout(t); }, [highlight]);

	async function showEarlier() {
		const first = rows[0], from = state.ranges[0]?.from;
		if (!first || from === undefined) return;
		const element = document.getElementById(`message-${first.id}`);
		anchor.current = element ? { id: first.id, top: element.getBoundingClientRect().top } : null;
		setEarlier('loading');
		setEarlier(await loadWindow({ before: from, limit: chatLimits.threadPage }) ? 'idle' : 'failed');
	}
	/** Load the missing seqs after `after` (between two loaded ranges), keeping the next message where it is. */
	async function fillHole(after: number) {
		const next = rows.find(m => m.seq > after);
		const element = next ? document.getElementById(`message-${next.id}`) : null;
		anchor.current = next && element ? { id: next.id, top: element.getBoundingClientRect().top } : null;
		setFilling({ after, failed: false });
		const ok = await loadWindow({ after, limit: chatLimits.threadPage });
		setFilling(ok ? null : { after, failed: true });
	}
	async function goTo(messageId: string, seq: number) {
		if (rows.some(m => m.id === messageId)) {
			document.getElementById(`message-${messageId}`)?.scrollIntoView({ block: 'center' });
			setHighlight(messageId); return;
		}
		scrollTo.current = messageId;
		if (!await loadWindow({ after: seq - 1, limit: chatLimits.threadPage })) scrollTo.current = null;
	}

	// Read position: only what is on screen, above the composer and the tab bar, in the full thread.
	const list = useRef<HTMLDivElement>(null);
	const reading = useRef({ nextAt: 0, timer: 0 as number | 0, inFlight: false });
	const readState = useRef({ state, lastReadSeq, status });
	readState.current = { state, lastReadSeq, status };
	const maybeRead = useCallback(() => {
		const r = reading.current, { state: s, lastReadSeq: seen, status: now } = readState.current;
		if (now.kind !== 'live' || !alive.current || r.inFlight || !s.current) return;
		if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
		const composer = document.querySelector('.chat-compose--thread')?.getBoundingClientRect().top ?? window.innerHeight;
		const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
		const shown: number[] = [];
		list.current?.querySelectorAll<HTMLElement>('li[data-seq]').forEach(element => {
			const box = element.getBoundingClientRect();
			if (box.top >= top && box.bottom <= composer && box.height > 0) shown.push(Number(element.dataset.seq));
		});
		const highest = highestDisplayed(shown, s);
		if (highest <= seen) return;
		const wait = r.nextAt - Date.now();
		if (wait > 0) { if (!r.timer) r.timer = window.setTimeout(() => { r.timer = 0; maybeRead(); }, wait); return; }
		r.nextAt = Date.now() + chatTiming.readThrottleMs; r.inFlight = true;
		void markRead({ scope, conversationId, seq: highest }).then(result => {
			r.inFlight = false;
			if (!alive.current) return;
			if (result.ok) setLastReadSeq(v => Math.max(v, result.value.lastReadSeq));
			else if (result.kind === 'rate-limited') r.nextAt = Math.max(r.nextAt, Date.now() + Math.min(result.retryAfter, chatTiming.retryAfterCapS) * 1000);
			else if (result.kind === 'gone') onGone();
			else if (result.kind === 'wrong-scope') onScope(result.error);
			else if (result.kind === 'signed-out') onSignedOut();
			// Other failures change nothing visible and never lock the composer; a later advance supersedes it.
		}, () => { r.inFlight = false; });
	}, [scope, conversationId, onGone, onScope, onSignedOut]);
	useEffect(() => {
		const observer = new IntersectionObserver(() => maybeRead(), { threshold: [0, 1] });
		list.current?.querySelectorAll('li[data-seq]').forEach(element => observer.observe(element));
		const again = () => maybeRead();
		window.addEventListener('focus', again); document.addEventListener('visibilitychange', again); window.addEventListener('resize', again);
		maybeRead();
		return () => { observer.disconnect(); window.removeEventListener('focus', again); document.removeEventListener('visibilitychange', again); window.removeEventListener('resize', again); };
	}, [rows, state.current, maybeRead]);
	useEffect(() => () => { if (reading.current.timer) window.clearTimeout(reading.current.timer); }, []);

	if (status.kind === 'gone') return <AccessLost scope={scope} conversationId={conversationId} />;
	/** Expired session or another organisation, noticed by the poll or by any write: drafts and pending records stay,
	 *  and no write or manual read can start from this page until sign-in or reload. */
	const halted = status.kind === 'signed-out' || status.kind === 'scope';
	return <div className="chat-thread">
		<ThreadHeader viewer={viewer} conversation={conversation} halted={halted} onChange={changeHeader} onGone={onGone} onScope={onScope} onSignedOut={onSignedOut} />
		{headerBehind && status.kind === 'live' ? <p className="muted" role="status">The title, people or links changed. Updating…</p> : null}
		{status.kind === 'scope' ? <div className="card notice notice--attention" role="alert"><p>{status.message} Nothing was sent.</p>
			<button type="button" className="button button--secondary" onClick={() => window.location.reload()}>Reload</button></div> : null}
		{status.kind === 'signed-out' ? <div className="card notice notice--attention" role="alert"><p>Your session has ended, so new messages are not being checked.</p>
			<a className="button button--secondary" href={`/sign-in?return_to=${encodeURIComponent(`/chat/${conversationId}`)}`}>Sign in again</a></div> : null}
		{status.kind === 'idle' ? <div className="card notice" role="status"><p>Paused after 10 minutes without activity.</p>
			<button type="button" className="button button--secondary" onClick={() => { setStatus(s => s.kind === 'idle' ? { kind: 'live' } : s); poller.current?.activity(); }}>Continue</button></div> : null}
		<PinsBlock pins={pinsLive} onGoTo={(id, seq) => void goTo(id, seq)} />
		<div ref={list} className="chat-stream">
			{hasEarlier ? <div className="chat-earlier">
				<button type="button" className="button button--ghost" disabled={earlier === 'loading' || halted} onClick={() => void showEarlier()}>{earlier === 'loading' ? 'Loading earlier messages…' : 'Earlier messages'}</button>
				{earlier === 'failed' ? <p className="form__error" role="alert">Earlier messages could not be read. Try again.</p> : null}
			</div> : null}
			{rows.length === 0 ? <p className="muted chat-empty">No messages yet. Say what this conversation is about.</p>
				: <MessageList rows={rows} viewer={viewer} moderator={canModerate(viewer)} livePinByMessage={livePinByMessage} actions={actions} label="Messages" highlighted={highlight} halted={halted}
					gapAfter={seq => holes.includes(seq) ? <>
						<span>Messages not loaded</span>
						<button type="button" className="button button--ghost button--small" disabled={(filling?.after === seq && !filling.failed) || halted} onClick={() => void fillHole(seq)}>
							{filling?.after === seq && !filling.failed ? 'Loading…' : 'Show'}</button>
						{filling?.after === seq && filling.failed ? <span className="form__error" role="alert">These messages could not be read. Try again.</span> : null}
					</> : null} />}
			{!viewer.timezoneKnown ? <p className="muted">Times are shown in UTC because the organisation’s timezone could not be read.</p> : null}
			{delayed && status.kind === 'live' ? <p className="muted" role="status">New messages could not be checked just now. Captain will try again.</p> : null}
		</div>
		{showNew ? <button type="button" className="chat-new" onClick={() => { setShowNew(false); window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }); }}>New messages <span aria-hidden="true">↓</span></button> : null}
		<Composer viewer={viewer} conversationId={conversationId} title={conversation.title} source="thread" seenIds={seenIds} halted={halted}
			onSent={() => { nearBottom.current = true; void loadNewer(); }} onGone={onGone} onScope={onScope} onSignedOut={onSignedOut} />
	</div>;
}

/** Title, star, people and links (mockup "conversation"). The star is personal; an uncertain toggle re-reads it. */
function ThreadHeader({ viewer, conversation: c, halted, onChange, onGone, onScope, onSignedOut }: {
	viewer: Viewer; conversation: ConversationDetail; halted: boolean; onChange(c: ConversationDetail): void; onGone(): void; onScope(message: string): void; onSignedOut(): void;
}) {
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	/** The star state a write may or may not have set; kept, with the star locked, until a read says which. */
	const [pendingStar, setPendingStar] = useState<boolean | null>(null);
	const [waitUntil, setWaitUntil] = useState<number | null>(null);
	useEffect(() => {
		if (waitUntil === null) return;
		const timer = window.setTimeout(() => setWaitUntil(null), Math.max(0, waitUntil - Date.now()) + 50);
		return () => window.clearTimeout(timer);
	}, [waitUntil]);
	const others = c.participants.filter(p => p.userId.toLowerCase() !== viewer.userId.toLowerCase());
	const people = others.length === 0 ? 'Only you' : [...others.map(p => p.name), 'you'].join(', ');
	const shown = c.links.slice(0, 2), more = c.links.length - shown.length;
	/** Read only: does the intended star state hold? Unresolved while the read fails. */
	async function settle(wanted: boolean) {
		const read = await getConversation(viewer.scope, c.id).catch(() => null);
		if (read?.ok) { onChange(read.value); setPendingStar(null); setProblem(read.value.starred === wanted ? null : 'Not saved. Try again when you are ready.'); return; }
		if (read?.kind === 'gone') { onGone(); return; }
		if (read?.kind === 'signed-out') { setPendingStar(wanted); onSignedOut(); return; }
		if (read?.kind === 'wrong-scope') { setPendingStar(wanted); onScope(read.error); return; }
		setPendingStar(wanted); setProblem('Captain could not confirm whether that was saved. Check your connection, then check again.');
	}
	async function toggle() {
		if (busy || halted || pendingStar !== null || waitUntil !== null) return;
		const wanted = !c.starred;
		setBusy(true); setProblem(null);
		try {
			const result = await setStar({ scope: viewer.scope, conversationId: c.id, starred: wanted }).catch(() => null);
			if (result?.ok) { onChange({ ...c, starred: result.value.starred }); return; }
			if (result === null || result.kind === 'uncertain') { await settle(wanted); return; }
			if (result.kind === 'gone') onGone();
			else if (result.kind === 'wrong-scope') onScope(result.error);
			else if (result.kind === 'signed-out') onSignedOut();
			else if (result.kind === 'rate-limited') {
				const seconds = Math.max(1, result.retryAfter ?? 1);
				setWaitUntil(Date.now() + seconds * 1000); setProblem(`Too many changes just now. Try again in ${seconds} seconds; nothing was changed.`);
			} else setProblem(result.error);
		} finally { setBusy(false); }
	}
	async function checkAgain() {
		if (pendingStar === null || busy || halted) return;
		setBusy(true);
		try { await settle(pendingStar); } finally { setBusy(false); }
	}
	return <header className="chat-header">
		<div className="chat-header__title">
			<p className="chat-title" aria-hidden="true"><span className="chat-title__symbol">#</span>{c.title}</p>
			<button type="button" className="chat-star" aria-pressed={c.starred} aria-label={c.starred ? 'Starred' : 'Star'} disabled={busy || halted || pendingStar !== null || waitUntil !== null} onClick={() => void toggle()}>{c.starred ? '★' : '☆'}</button>
		</div>
		<p className="chat-people">{people}</p>
		{c.links.length ? <ul className="bare chat-links" aria-label="Linked work">
			{shown.map(link => <li key={link.id}><Link className="chat-link" href={link.kind === 'task' ? `/work/tasks/${link.targetId}` : `/work/projects/${link.targetId}`}>
				<span className="chat-link__kind">{link.kind === 'task' ? 'Task' : 'Project'}</span>{link.title}<span aria-hidden="true">›</span></Link></li>)}
			{more > 0 ? <li><Link className="chat-link chat-link--more" href={`/chat/${c.id}/details`}>+{more} more</Link></li> : null}
		</ul> : null}
		<Link className="chat-details-link" href={`/chat/${c.id}/details`}>Details</Link>
		{problem ? <p className="form__error" role="alert">{problem}</p> : null}
		{pendingStar !== null ? <button type="button" className="button button--secondary" disabled={busy || halted} onClick={() => void checkAgain()}>{busy ? 'Checking…' : 'Check again'}</button> : null}
	</header>;
}
