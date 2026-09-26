'use client';
import type { PinWithMessage } from '../../app/chat/types.ts';
import { Body } from './MessageRow.tsx';

/** Every live pin, above the messages, never collapsed (contract §13). Each shows its original message (hydrated by
 *  the pins read, so a pin outside the loaded messages still shows) and goes to it. The count is the real number of
 *  live pins. A pin whose message is known to be deleted is never passed in. */
export function PinsBlock({ pins, onGoTo, hrefFor }: { pins: PinWithMessage[]; onGoTo?(messageId: string, seq: number): void; hrefFor?(messageId: string): string }) {
	if (pins.length === 0) return null;
	return <section className="chat-pins" aria-labelledby="chat-pins-heading">
		<h2 id="chat-pins-heading" className="chat-pins__heading"><span aria-hidden="true">📌</span> Pinned for everyone <span className="chat-pins__count">{pins.length}</span></h2>
		<ul className="bare chat-pins__list">
			{pins.map(pin => <li key={pin.id} className="chat-pin">
				<strong>{pin.message.authorName ?? 'Former member'}</strong>
				<p className="chat-pin__text"><Body text={pin.message.body ?? ''} /></p>
				{hrefFor ? <a className="chat-pin__go" href={hrefFor(pin.message.id)}>Go to message <span aria-hidden="true">↗</span></a>
					: <button type="button" className="chat-pin__go" onClick={() => onGoTo?.(pin.message.id, pin.message.seq)}>Go to message <span aria-hidden="true">↗</span></button>}
			</li>)}
		</ul>
	</section>;
}
