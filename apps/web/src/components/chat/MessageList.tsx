'use client';
import type { ReactNode } from 'react';
import type { Message, Pin } from '../../app/chat/types.ts';
import { withDays } from './days.ts';
import { MessageRow } from './MessageRow.tsx';
import type { MessageActions } from './feed-state.ts';
import type { Viewer } from './viewer-types.ts';

/** Messages in `seq` order with day separators in the organisation's timezone. Row shading alternates by message
 *  index, not by list position, so separators never break the pattern. One row per message id. `gapAfter(seq)` marks
 *  messages that are not loaded after that seq (between two loaded ranges), so separate ranges never read as one. */
export function MessageList({ rows, viewer, moderator, livePinByMessage, actions, label, highlighted = null, compact = false, gapAfter, halted = false }: {
	rows: Message[]; viewer: Viewer; moderator: boolean; livePinByMessage: Map<string, Pin>; actions: MessageActions;
	label: string; highlighted?: string | null; compact?: boolean; gapAfter?: (seq: number) => ReactNode | null;
	/** Expired session or another organisation: every row keeps its draft and allows no write or check. */
	halted?: boolean;
}) {
	let index = 0;
	return <ol className={`chat-messages${compact ? ' chat-messages--compact' : ''}`} aria-label={label}>
		{withDays(rows, viewer.timezone).flatMap(item => {
			if (item.kind === 'day') return [<li key={`day-${item.key}`} className="chat-day" role="separator" aria-label={item.label}><span>{item.label}</span></li>];
			const gap = gapAfter?.(item.row.seq) ?? null;
			const row = <MessageRow key={item.row.id} message={item.row} viewer={viewer} moderator={moderator} pin={livePinByMessage.get(item.row.id) ?? null}
				alternate={index++ % 2 === 0} actions={actions} highlighted={highlighted === item.row.id} halted={halted} />;
			return gap === null ? [row] : [row, <li key={`gap-${item.row.seq}`} className="chat-gap">{gap}</li>];
		})}
	</ol>;
}
