/** Linked chat as the API sends it (contract `docs/plans/linked-chat-2026-09.md` §15, web plan §3 A1–A4). Dates are
 *  ISO strings. Pure: shared by server actions, server pages and client components. */

/** The person and organisation a page was rendered for; every action refuses a different one before any call. */
export type ChatScope = { userId: string; organisationId: string };
export type ListFilter = 'all' | 'unread' | 'starred';
export type LinkKind = 'task' | 'project';
export type Participant = { userId: string; name: string; addedAt: string };
export type Link = { id: string; kind: LinkKind; targetId: string; title: string; state: string; createdAt: string };
/** `starred`, `lastReadSeq` and `unread` are the caller's own; `unread` is capped at 51 by the API. */
export type ConversationSummary = { id: string; title: string; revision: number; lastSeq: number; lastChange: number;
	lastMessageAt: string | null; createdAt: string; starred: boolean; lastReadSeq: number; unread: number };
/** List and work-to-chat rows only (A4): the latest message, excerpted, and the first link with the real link count. */
export type ConversationRow = ConversationSummary & {
	latest: { seq: number; authorName: string | null; excerpt: string | null; deleted: boolean } | null;
	linkSummary: { first: { kind: LinkKind; targetId: string; title: string } | null; count: number };
};
export type ConversationDetail = ConversationSummary & { createdBy: string | null; participants: Participant[]; links: Link[] };
/** A tombstone keeps its id and seq with `body: null`. `authorName` is null only when the attribution was deleted. */
export type Message = { id: string; conversationId: string; seq: number; changeSeq: number; authorId: string | null;
	authorName: string | null; body: string | null; createdAt: string; editedAt: string | null; deletedAt: string | null;
	deletedBy: string | null; revision: number };
/** `unpinnedAt` is null while the pin is live. */
export type Pin = { id: string; conversationId: string; messageId: string; changeSeq: number; pinnedBy: string | null;
	pinnedAt: string; unpinnedBy: string | null; unpinnedAt: string | null };
/** A live pin from `GET …/pins`, with its message from the same snapshot (A2). */
export type PinWithMessage = Pin & { message: Message };
export type Change = { changeSeq: number; kind: 'message'; message: Message } | { changeSeq: number; kind: 'pin'; pin: Pin };
export type ListPage = { conversations: ConversationRow[]; nextCursor: string | null };
export type MessagesPage = { conversation: { id: string; revision: number; lastSeq: number; lastChange: number }; messages: Message[]; hasMore: boolean };
export type ChangesPage = { conversation: { id: string; revision: number; lastSeq: number; highWater: number }; changes: Change[]; next: number; complete: boolean };
export type PinsPage = { conversation: { id: string; revision: number; lastChange: number }; pins: PinWithMessage[] };
export type MessageWindow = { latest: number } | { after: number; limit: number } | { before: number; limit: number };
/** A member who can be added to a conversation (the API lists active members only). */
export type ChatMember = { userId: string; name: string };
/** What an edit or delete was meant to do, kept with the message's seq so it can be re-read (there is no by-id read).
 *  An edit's `body` is `normaliseBody(input)`, the exact text sent, so reconciliation compares like with like. */
export type MessageIntent = { messageId: string; seq: number; kind: 'edit'; fromRevision: number; body: string }
	| { messageId: string; seq: number; kind: 'delete'; fromRevision: number };

export const chatLimits = { titleMax: 80, bodyMaxCodePoints: 4000, bodyMaxBytes: 16_384, createOthersMax: 49,
	addBatchMax: 20, participantsMax: 50, linksMax: 10, livePinsMax: 50, unreadCap: 51, listPage: 50, itemPanelRows: 20,
	panelLatest: 6, threadPage: 50, changesPage: 100 } as const;
export const chatTiming = { pollMs: 15_000, idleStopMs: 600_000, readThrottleMs: 15_000, backoffMaxMs: 60_000, retryAfterCapS: 300 } as const;

/** A conversation's own unread marker: 1–50, or "50+" at the API's cap. Never summed across conversations. */
export const unreadLabel = (unread: number): string | null => unread <= 0 ? null : unread >= chatLimits.unreadCap ? '50+' : String(unread);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
/** A client-made identity (conversation or message id): a UUID other than the nil one. */
export const isClientId = (value: unknown): value is string => isUuid(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);

const bytes = (text: string) => new TextEncoder().encode(text).length;
/** The API's message rule (contract §5): trimmed, 1–4,000 code points and at most 16 KB of UTF-8. */
export function normaliseBody(raw: string): string | { error: string } {
	const body = raw.trim();
	const points = [...body].length;
	if (points < 1) return { error: 'Write a message first.' };
	if (points > chatLimits.bodyMaxCodePoints) return { error: `A message is at most 4,000 characters; this one has ${points.toLocaleString('en')}.` };
	if (bytes(body) > chatLimits.bodyMaxBytes) return { error: 'This message is too large to send. Shorten it and try again.' };
	return body;
}

/** A conversation title: trimmed, 1–80 characters (the API counts UTF-16 code units, as `z.string().max`). */
export function normaliseTitle(raw: string): string | { error: string } {
	const title = raw.trim();
	if (!title) return { error: 'Give the conversation a title.' };
	if (title.length > chatLimits.titleMax) return { error: 'A title is at most 80 characters.' };
	return title;
}
