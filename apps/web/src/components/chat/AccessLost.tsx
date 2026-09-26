'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { chatStorage as tabStorage, clearSend } from '../../app/chat/pending.ts';
import type { ChatScope } from '../../app/chat/types.ts';

/** Lost access looks the same wherever it is noticed (contract §8): never the conversation's title, people or text.
 *  It clears this tab's unsent message for that conversation, whether access was lost while reading (the thread's
 *  404) or the page itself opened on a 404, so the wording below is true in both cases. */
export function AccessLost({ scope, conversationId }: { scope: ChatScope; conversationId: string }) {
	useEffect(() => { clearSend(tabStorage(), scope, conversationId); }, [scope, conversationId]);
	return <div className="card notice notice--attention chat-access-lost" role="alert">
		<h2>This conversation is not available to you</h2>
		<p className="secondary">You may have left it, been removed, or never been added. Anything you had not sent from here has been cleared.</p>
		<Link className="button button--secondary" href="/chat">Back to Chat</Link>
	</div>;
}
