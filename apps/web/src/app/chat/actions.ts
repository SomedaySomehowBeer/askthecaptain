'use server';
/** Linked chat's server actions (web plan §2, handoff §5). Every action names the person and organisation its page was
 *  rendered for and is refused, before any API call, when another is now active in this browser. Reads may also be
 *  called directly by server pages. Writes return the API's plain body wrapped in a `ChatResult`; nothing here retries. */
import { revalidatePath } from 'next/cache';
import { api, ApiError, type Member } from '../../lib/api.ts';
import { actionSession } from '../../lib/session.ts';
import { notSent, signedOut, toReadFailure, toWriteFailure, wrongScope, type ChatFailure, type ChatRead, type ChatResult } from './results.ts';
import {
	chatLimits, isClientId, isUuid, normaliseBody, normaliseTitle,
	type ChangesPage, type ChatMember, type ChatScope, type ConversationDetail, type ConversationRow, type LinkKind, type ListFilter,
	type ListPage, type Message, type MessageIntent, type MessagesPage, type MessageWindow, type Pin, type PinsPage
} from './types.ts';

type Session = { token: string; org: string };

function sameScope(scope: unknown, active: ChatScope): boolean {
	if (!scope || typeof scope !== 'object') return false;
	const { userId, organisationId } = scope as Record<string, unknown>;
	return typeof userId === 'string' && typeof organisationId === 'string'
		&& userId.toLowerCase() === active.userId.toLowerCase() && organisationId.toLowerCase() === active.organisationId.toLowerCase();
}

/** The session to call with, only when it is the scope the page was rendered for. The organisation cookie is shared by
 *  every tab, so another tab may have switched it; nothing is sent then. */
async function scopedSession(scope: unknown): Promise<{ ok: true; session: Session } | Extract<ChatFailure, { kind: 'not-sent' | 'signed-out' | 'wrong-scope' }>> {
	const session = await actionSession();
	if (!session.ok) return session.reason === 'signed-out' ? signedOut() : notSent(session.error);
	if (!sameScope(scope, { userId: session.current.me.user.id, organisationId: session.org })) return wrongScope();
	return { ok: true, session: { token: session.token, org: session.org } };
}

const chats = (s: Session, conversationId?: string) => `/v1/organisations/${s.org}/conversations${conversationId ? `/${conversationId.toLowerCase()}` : ''}`;
const isRevision = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 2_147_483_646;
const isCounter = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647;
const isKind = (value: unknown): value is LinkKind => value === 'task' || value === 'project';
const badReference = () => notSent('That conversation reference is not valid. Reload the page.');
function listChanged() { revalidatePath('/chat'); }

async function read<T>(scope: unknown, work: (s: Session) => Promise<T>): Promise<ChatRead<T>> {
	const scoped = await scopedSession(scope);
	if (!scoped.ok) return scoped;
	try { return { ok: true, value: await work(scoped.session) }; }
	catch (error) { return toReadFailure(error); }
}

// Reads

export async function listConversations(scope: ChatScope, q: { filter: ListFilter; linked: boolean; cursor: string | null }): Promise<ChatRead<ListPage>> {
	if (!['all', 'unread', 'starred'].includes(q.filter) || typeof q.linked !== 'boolean' || (q.cursor !== null && (typeof q.cursor !== 'string' || !q.cursor || q.cursor.length > 300))) {
		return notSent('That list link could not be read.');
	}
	const query = new URLSearchParams({ filter: q.filter, linked: String(q.linked), limit: String(chatLimits.listPage) });
	if (q.cursor) query.set('cursor', q.cursor);
	return read(scope, (s) => api<ListPage>(`${chats(s)}?${query}`, { token: s.token }));
}

export async function conversationsFor(scope: ChatScope, kind: LinkKind, targetId: string): Promise<ChatRead<{ conversations: ConversationRow[] }>> {
	if (!isKind(kind) || !isUuid(targetId)) return notSent('That task or project reference is not valid.');
	return read(scope, (s) => api<{ conversations: ConversationRow[] }>(`/v1/organisations/${s.org}/${kind === 'task' ? 'tasks' : 'projects'}/${targetId.toLowerCase()}/conversations`, { token: s.token }));
}

export async function getConversation(scope: ChatScope, conversationId: string): Promise<ChatRead<ConversationDetail>> {
	if (!isUuid(conversationId)) return badReference();
	return read(scope, (s) => api<ConversationDetail>(chats(s, conversationId), { token: s.token }));
}

function windowQuery(window: MessageWindow): string | null {
	const limit = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 100;
	if ('latest' in window) return limit(window.latest) ? `latest=${window.latest}` : null;
	if ('after' in window) return isCounter(window.after) && limit(window.limit) ? `after=${window.after}&limit=${window.limit}` : null;
	if ('before' in window) return isCounter(window.before) && limit(window.limit) ? `before=${window.before}&limit=${window.limit}` : null;
	return null;
}

export async function readMessages(scope: ChatScope, conversationId: string, window: MessageWindow): Promise<ChatRead<MessagesPage>> {
	const query = window && typeof window === 'object' ? windowQuery(window) : null;
	if (!isUuid(conversationId) || !query) return badReference();
	return read(scope, (s) => api<MessagesPage>(`${chats(s, conversationId)}/messages?${query}`, { token: s.token }));
}

export async function readChanges(scope: ChatScope, conversationId: string, after: number, limit: number = chatLimits.changesPage): Promise<ChatRead<ChangesPage>> {
	if (!isUuid(conversationId) || !isCounter(after) || !Number.isInteger(limit) || limit < 1 || limit > 100) return badReference();
	return read(scope, (s) => api<ChangesPage>(`${chats(s, conversationId)}/changes?after=${after}&limit=${limit}`, { token: s.token }));
}

export async function readPins(scope: ChatScope, conversationId: string): Promise<ChatRead<PinsPage>> {
	if (!isUuid(conversationId)) return badReference();
	return read(scope, (s) => api<PinsPage>(`${chats(s, conversationId)}/pins`, { token: s.token }));
}

/** Active members, by name (the API lists active members only; the status check keeps that true here too). */
export async function readMembers(scope: ChatScope): Promise<ChatRead<ChatMember[]>> {
	return read(scope, async (s) => {
		const { members } = await api<{ members: Member[] }>(`/v1/organisations/${s.org}/members`, { token: s.token });
		return members.filter((m) => m.status === 'active').map((m) => ({ userId: m.userId.toLowerCase(), name: m.name || m.email }))
			.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
	});
}

// Writes

async function write<T>(scope: unknown, work: (s: Session) => Promise<T>, failed: (error: unknown, s: Session) => Promise<ChatResult<T>> = async (error) => toWriteFailure<T>(error)): Promise<ChatResult<T>> {
	const scoped = await scopedSession(scope);
	if (!scoped.ok) return scoped;
	try { return { ok: true, value: await work(scoped.session), requestId: null }; }
	catch (error) { return failed(error, scoped.session); }
}

const isStale = (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'stale_revision';

/** A stale details write carries the conversation as it is now, when it can be read. */
async function staleDetail(error: unknown, s: Session, conversationId: string): Promise<ChatFailure<ConversationDetail>> {
	if (!isStale(error)) return toWriteFailure<ConversationDetail>(error);
	const current = await api<ConversationDetail>(chats(s, conversationId), { token: s.token }).catch(() => null);
	return toWriteFailure(error, current);
}

/** A stale edit or delete carries the message as it is now, read back by its seq (there is no read by id). */
async function staleMessage(error: unknown, s: Session, conversationId: string, intent: MessageIntent): Promise<ChatFailure<Message>> {
	if (!isStale(error)) return toWriteFailure<Message>(error);
	const page = await api<MessagesPage>(`${chats(s, conversationId)}/messages?after=${intent.seq - 1}&limit=1`, { token: s.token }).catch(() => null);
	return toWriteFailure(error, page?.messages.find((m) => m.id === intent.messageId.toLowerCase()) ?? null);
}

/** Create with the caller's id. After an uncertain result the same id and payload may be sent again: the API returns
 *  the matched conversation for an identical retry. */
export async function createConversation(i: { scope: ChatScope; id: string; title: string; participantIds: string[]; links: { kind: LinkKind; targetId: string }[] }): Promise<ChatResult<ConversationDetail>> {
	if (!isClientId(i.id)) return notSent('This new conversation has no valid identity. Start again.');
	const title = normaliseTitle(i.title);
	if (typeof title !== 'string') return notSent(title.error);
	if (!Array.isArray(i.participantIds) || !i.participantIds.every(isUuid)) return notSent('Someone chosen is not a valid member. Check the people and try again.');
	const me = i.scope?.userId?.toLowerCase();
	const people = [...new Set(i.participantIds.map((id) => id.toLowerCase()))].filter((id) => id !== me).sort();
	if (people.length > chatLimits.createOthersMax) return notSent('A new conversation can include up to 49 other people.');
	if (!Array.isArray(i.links) || !i.links.every((l) => l && isKind(l.kind) && isUuid(l.targetId))) return notSent('A chosen link is not valid. Check the links and try again.');
	const links = [...new Map(i.links.map((l) => [`${l.kind}:${l.targetId.toLowerCase()}`, { kind: l.kind, targetId: l.targetId.toLowerCase() }])).values()];
	if (links.length > chatLimits.linksMax) return notSent('A conversation can link up to 10 tasks and projects.');
	return write(i.scope, async (s) => {
		const detail = await api<ConversationDetail>(chats(s), { method: 'POST', token: s.token, body: { id: i.id.toLowerCase(), title, participantIds: people, links } });
		listChanged();
		return detail;
	}, async (error) => {
		// A create has no conversation to lose: its 404 means the person is no longer an active member here.
		if (error instanceof ApiError && error.status === 404) {
			return { ok: false, kind: 'refused', code: 'not_found', retryAfter: null, requestId: error.requestId, error: 'You no longer have access to this organisation’s Chat, so nothing was created. Reload the page to check your access.' };
		}
		return toWriteFailure<ConversationDetail>(error);
	});
}

export async function renameConversation(i: { scope: ChatScope; conversationId: string; expectedRevision: number; title: string }): Promise<ChatResult<ConversationDetail>> {
	if (!isUuid(i.conversationId) || !isRevision(i.expectedRevision)) return badReference();
	const title = normaliseTitle(i.title);
	if (typeof title !== 'string') return notSent(title.error);
	return write(i.scope, async (s) => {
		const detail = await api<ConversationDetail>(chats(s, i.conversationId), { method: 'PATCH', token: s.token, body: { expectedRevision: i.expectedRevision, title } });
		listChanged();
		return detail;
	}, (error, s) => staleDetail(error, s, i.conversationId));
}

export async function addParticipants(i: { scope: ChatScope; conversationId: string; expectedRevision: number; userIds: string[] }): Promise<ChatResult<ConversationDetail>> {
	if (!isUuid(i.conversationId) || !isRevision(i.expectedRevision)) return badReference();
	if (!Array.isArray(i.userIds) || !i.userIds.every(isUuid)) return notSent('Someone chosen is not a valid member. Check the people and try again.');
	const userIds = [...new Set(i.userIds.map((id) => id.toLowerCase()))].sort();
	if (userIds.length < 1) return notSent('Choose someone to add.');
	if (userIds.length > chatLimits.addBatchMax) return notSent('Add up to 20 people at a time.');
	return write(i.scope, async (s) => {
		const detail = await api<ConversationDetail>(`${chats(s, i.conversationId)}/participants`, { method: 'POST', token: s.token, body: { expectedRevision: i.expectedRevision, userIds } });
		listChanged();
		return detail;
	}, (error, s) => staleDetail(error, s, i.conversationId));
}

/** Remove someone, or leave (the caller's own id). */
export async function removeParticipant(i: { scope: ChatScope; conversationId: string; userId: string; expectedRevision: number }): Promise<ChatResult<{ revision: number }>> {
	if (!isUuid(i.conversationId) || !isUuid(i.userId) || !isRevision(i.expectedRevision)) return badReference();
	return write(i.scope, async (s) => {
		const { revision } = await api<{ ok: true; revision: number }>(`${chats(s, i.conversationId)}/participants/${i.userId.toLowerCase()}?expectedRevision=${i.expectedRevision}`, { method: 'DELETE', token: s.token });
		listChanged();
		return { revision };
	}, async (error, s) => {
		const stale = await staleDetail(error, s, i.conversationId);
		return stale.kind === 'stale' ? { ...stale, current: stale.current ? { revision: stale.current.revision } : null } : stale;
	});
}

export async function addLink(i: { scope: ChatScope; conversationId: string; expectedRevision: number; kind: LinkKind; targetId: string }): Promise<ChatResult<ConversationDetail>> {
	if (!isUuid(i.conversationId) || !isRevision(i.expectedRevision)) return badReference();
	if (!isKind(i.kind) || !isUuid(i.targetId)) return notSent('Choose a task or project to link.');
	return write(i.scope, async (s) => {
		const detail = await api<ConversationDetail>(`${chats(s, i.conversationId)}/links`, { method: 'POST', token: s.token, body: { expectedRevision: i.expectedRevision, kind: i.kind, targetId: i.targetId.toLowerCase() } });
		listChanged();
		return detail;
	}, (error, s) => staleDetail(error, s, i.conversationId));
}

export async function removeLink(i: { scope: ChatScope; conversationId: string; linkId: string; expectedRevision: number }): Promise<ChatResult<ConversationDetail>> {
	if (!isUuid(i.conversationId) || !isUuid(i.linkId) || !isRevision(i.expectedRevision)) return badReference();
	return write(i.scope, async (s) => {
		const detail = await api<ConversationDetail>(`${chats(s, i.conversationId)}/links/${i.linkId.toLowerCase()}?expectedRevision=${i.expectedRevision}`, { method: 'DELETE', token: s.token });
		listChanged();
		return detail;
	}, (error, s) => staleDetail(error, s, i.conversationId));
}

/** Send with the caller's id. An identical retry after an uncertain result returns the stored message. */
export async function sendMessage(i: { scope: ChatScope; conversationId: string; id: string; body: string }): Promise<ChatResult<Message>> {
	if (!isUuid(i.conversationId)) return badReference();
	if (!isClientId(i.id)) return notSent('This message has no valid identity. Send it as a new message.');
	const body = typeof i.body === 'string' ? normaliseBody(i.body) : { error: 'Write a message first.' };
	if (typeof body !== 'string') return notSent(body.error);
	return write(i.scope, (s) => api<Message>(`${chats(s, i.conversationId)}/messages`, { method: 'POST', token: s.token, body: { id: i.id.toLowerCase(), body } }));
}

function validIntent(intent: MessageIntent | undefined, kind: MessageIntent['kind']): boolean {
	return !!intent && intent.kind === kind && isUuid(intent.messageId) && Number.isInteger(intent.seq) && intent.seq >= 1 && isRevision(intent.fromRevision);
}

export async function editMessage(i: { scope: ChatScope; conversationId: string; intent: Extract<MessageIntent, { kind: 'edit' }> }): Promise<ChatResult<Message>> {
	if (!isUuid(i.conversationId) || !validIntent(i.intent, 'edit')) return badReference();
	const body = typeof i.intent.body === 'string' ? normaliseBody(i.intent.body) : { error: 'Write a message first.' };
	if (typeof body !== 'string') return notSent(body.error);
	if (body !== i.intent.body) return notSent('This edit was not prepared as it will be sent. Edit the message again.');
	return write(i.scope,
		(s) => api<Message>(`${chats(s, i.conversationId)}/messages/${i.intent.messageId.toLowerCase()}`, { method: 'PATCH', token: s.token, body: { expectedRevision: i.intent.fromRevision, body } }),
		(error, s) => staleMessage(error, s, i.conversationId, i.intent));
}

export async function deleteMessage(i: { scope: ChatScope; conversationId: string; intent: Extract<MessageIntent, { kind: 'delete' }> }): Promise<ChatResult<Message>> {
	if (!isUuid(i.conversationId) || !validIntent(i.intent, 'delete')) return badReference();
	return write(i.scope,
		(s) => api<Message>(`${chats(s, i.conversationId)}/messages/${i.intent.messageId.toLowerCase()}?expectedRevision=${i.intent.fromRevision}`, { method: 'DELETE', token: s.token }),
		(error, s) => staleMessage(error, s, i.conversationId, i.intent));
}

/** Pin a message. `409 message_already_pinned` means the intended state already holds: the live pin is read back and
 *  reported as done (this is also how an uncertain pin's retry resolves). */
export async function pinMessage(i: { scope: ChatScope; conversationId: string; messageId: string }): Promise<ChatResult<Pin>> {
	if (!isUuid(i.conversationId) || !isUuid(i.messageId)) return badReference();
	const messageId = i.messageId.toLowerCase();
	return write(i.scope, (s) => api<Pin>(`${chats(s, i.conversationId)}/pins`, { method: 'POST', token: s.token, body: { messageId } }), async (error, s) => {
		if (error instanceof ApiError && error.status === 409 && error.code === 'message_already_pinned') {
			const pins = await api<PinsPage>(`${chats(s, i.conversationId)}/pins`, { token: s.token }).catch(() => null);
			const live = pins?.pins.find((p) => p.messageId === messageId && p.unpinnedAt === null);
			if (live) { const { message: _, ...pin } = live; return { ok: true, value: pin, requestId: error.requestId }; }
		}
		return toWriteFailure<Pin>(error);
	});
}

export async function unpinMessage(i: { scope: ChatScope; conversationId: string; pinId: string }): Promise<ChatResult<Pin>> {
	if (!isUuid(i.conversationId) || !isUuid(i.pinId)) return badReference();
	return write(i.scope, (s) => api<Pin>(`${chats(s, i.conversationId)}/pins/${i.pinId.toLowerCase()}`, { method: 'DELETE', token: s.token }));
}

export async function setStar(i: { scope: ChatScope; conversationId: string; starred: boolean }): Promise<ChatResult<{ starred: boolean }>> {
	if (!isUuid(i.conversationId) || typeof i.starred !== 'boolean') return badReference();
	return write(i.scope, async (s) => {
		const result = await api<{ starred: boolean }>(`${chats(s, i.conversationId)}/star`, { method: i.starred ? 'POST' : 'DELETE', token: s.token });
		listChanged();
		return result;
	});
}

/** Advance the caller's read position. Only the full thread calls this, for the highest message displayed. */
export async function markRead(i: { scope: ChatScope; conversationId: string; seq: number }): Promise<ChatResult<{ lastReadSeq: number; unread: number }>> {
	if (!isUuid(i.conversationId) || !isCounter(i.seq)) return badReference();
	return write(i.scope, (s) => api<{ lastReadSeq: number; unread: number }>(`${chats(s, i.conversationId)}/read`, { method: 'POST', token: s.token, body: { seq: i.seq } }));
}
