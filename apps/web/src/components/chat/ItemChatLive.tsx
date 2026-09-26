'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readMessages, readPins } from '../../app/chat/actions.ts';
import { initialState, livePins, streamRows } from '../../app/chat/feed.ts';
import { chatLimits, type ConversationRow, type MessagesPage, type Pin, type PinsPage } from '../../app/chat/types.ts';
import { AccessLost } from './AccessLost.tsx';
import { Composer } from './Composer.tsx';
import { ConversationRowView } from './ConversationRowView.tsx';
import { messageActions, useFeed } from './feed-state.ts';
import { MessageList } from './MessageList.tsx';
import { PinsBlock } from './PinsBlock.tsx';
import { canModerate, type Viewer } from './viewer-types.ts';

type Status = { kind: 'live' } | { kind: 'gone' } | { kind: 'scope'; message: string } | { kind: 'signed-out' };
const latest = { latest: chatLimits.panelLatest };

/** The expanded conversation in a task or project panel. It shows what the server read, and reads again only when asked
 *  ("Check for new messages") or after this person sends; it never polls and never marks anything read, so opening a
 *  task does not change anyone's unread position. Row menus and the composer behave exactly as in the full thread,
 *  including the shared pending send, so a message started here blocks the thread's composer until it is confirmed. */
export function ItemChatLive({ viewer, row, messages, pins }: { viewer: Viewer; row: ConversationRow; messages: MessagesPage; pins: PinsPage }) {
	const scope = viewer.scope, conversationId = row.id;
	const feed = useFeed(() => initialState(messages, latest, pins));
	const { state } = feed;
	const [status, setStatus] = useState<Status>({ kind: 'live' });
	const [checking, setChecking] = useState<'idle' | 'loading' | 'failed'>('idle');
	const mounted = useRef(true);
	const generation = useRef(0);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);

	/** Set once the panel stops (access lost, expired session, another organisation): no read or write starts after. */
	const stoppedRef = useRef(false);
	const onGone = useCallback(() => { stoppedRef.current = true; if (mounted.current) setStatus({ kind: 'gone' }); }, []);
	const onScope = useCallback((message: string) => { stoppedRef.current = true; if (mounted.current) setStatus({ kind: 'scope', message }); }, []);
	/** Expired session: stop and offer sign-in; unsent records stay for this person (only explicit sign-out purges). */
	const onSignedOut = useCallback(() => { stoppedRef.current = true; if (mounted.current) setStatus({ kind: 'signed-out' }); }, []);
	const actions = useMemo(() => messageActions({ viewer, conversationId, feed, onGone, onScope, onSignedOut }),
		[viewer, conversationId, feed, onGone, onScope, onSignedOut]);

	/** Read the latest messages and the live pins again, as one fresh view. A slower earlier check never overwrites a
	 *  later one, and nothing lands after the panel has gone. */
	const check = useCallback(async () => {
		if (stoppedRef.current) return;
		const mine = ++generation.current;
		setChecking('loading');
		try {
			const [m, p] = await Promise.all([readMessages(scope, conversationId, latest), readPins(scope, conversationId)]);
			if (!mounted.current || mine !== generation.current) return;
			if (m.ok && p.ok) { feed.update(() => initialState(m.value, latest, p.value)); setChecking('idle'); return; }
			const failure = !m.ok ? m : !p.ok ? p : null;
			if (failure?.kind === 'gone') onGone();
			else if (failure?.kind === 'signed-out') onSignedOut();
			else if (failure?.kind === 'wrong-scope') onScope(failure.error);
			// A stopped panel says why in its own notice; only a plain read failure says "could not be checked".
			setChecking(stoppedRef.current ? 'idle' : 'failed');
		} catch {
			if (mounted.current && mine === generation.current) setChecking('failed');
		}
	}, [scope, conversationId, feed, onGone, onScope, onSignedOut]);

	const rows = useMemo(() => streamRows(state), [state]);
	const pinsLive = useMemo(() => livePins(state), [state]);
	const livePinByMessage = useMemo(() => new Map<string, Pin>(pinsLive.map(p => [p.messageId, p])), [pinsLive]);
	const seenIds = useMemo(() => new Set(state.messages.keys()), [state]);

	if (status.kind === 'gone') return <AccessLost scope={scope} conversationId={conversationId} />;
	const halted = status.kind === 'signed-out' || status.kind === 'scope';
	return <div className="chat-panel__live stack">
		<div className="chat-panel__card"><ConversationRowView conversation={row} /></div>
		{status.kind === 'scope' ? <div className="card notice notice--attention" role="alert"><p>{status.message} Nothing was sent.</p>
			<button type="button" className="button button--secondary" onClick={() => window.location.reload()}>Reload</button></div> : null}
		{status.kind === 'signed-out' ? <div className="card notice notice--attention" role="alert"><p>Your session has ended. Sign in again to send or change messages.</p>
			<a className="button button--secondary" href={`/sign-in?return_to=${encodeURIComponent(window.location.pathname)}`}>Sign in again</a></div> : null}
		<PinsBlock pins={pinsLive} hrefFor={messageId => `/chat/${conversationId}#message-${messageId}`} />
		<h3 className="chat-panel__subhead">Latest messages</h3>
		{rows.length === 0 ? <p className="muted">No messages yet.</p>
			: <MessageList rows={rows} viewer={viewer} moderator={canModerate(viewer)} livePinByMessage={livePinByMessage} actions={actions}
				label={`Latest messages in ${row.title}`} compact halted={halted} />}
		{!viewer.timezoneKnown ? <p className="muted">Times are shown in UTC because the organisation’s timezone could not be read.</p> : null}
		<div className="row">
			<button type="button" className="button button--ghost" disabled={checking === 'loading' || halted} onClick={() => void check()}>{checking === 'loading' ? 'Checking…' : 'Check for new messages'}</button>
			{checking === 'failed' ? <p className="form__error" role="alert">New messages could not be checked. Try again.</p> : null}
		</div>
		<Composer viewer={viewer} conversationId={conversationId} title={row.title} source="panel" seenIds={seenIds} halted={halted}
			onSent={() => void check()} onGone={onGone} onScope={onScope} onSignedOut={onSignedOut} />
	</div>;
}
