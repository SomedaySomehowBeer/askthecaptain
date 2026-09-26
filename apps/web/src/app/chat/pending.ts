/** Chat writes whose outcome is not yet known, kept in this tab's sessionStorage (web plan §2 "Pending lifecycle").
 *  A record is written *before* its request, restored and locked on the next load, and removed only when the outcome
 *  is confirmed, the person discards it, access to the conversation is lost, or the person signs out. There is one
 *  pending create per person and organisation and one pending send per conversation, shared by the full thread and
 *  the item-panel composer. Records hold client ids and the person's own draft and selections; never a token. */
import type { ChatResult } from './results.ts';
import { chatLimits, isClientId, isUuid, normaliseBody, normaliseTitle, type ChatScope, type ConversationDetail, type LinkKind, type Message } from './types.ts';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { readonly length?: number; key?(index: number): string | null };
export type PendingState = 'sending' | 'uncertain' | 'rate-limited' | 'refused';
export type PendingSend = { id: string; body: string; state: PendingState; retryAt: number | null /* epoch ms */; code: string | null };
export type PendingCreate = { id: string; title: string; participantIds: string[] /* sorted, lower-case */;
	links: { kind: LinkKind; targetId: string }[] /* sorted by kind then id, lower-case */; state: PendingState; retryAt: number | null; code: string | null };
export type Restored<T> = { state: 'none' } | { state: 'found'; record: T } | { state: 'invalid' } | { state: 'unavailable' };

const version = 1;
const prefix = 'captain.chat';
const lower = (s: string) => s.toLowerCase();
export const createKey = (scope: ChatScope): string => `${prefix}Create.v${version}.${lower(scope.userId)}.${lower(scope.organisationId)}`;
export const sendKey = (scope: ChatScope, conversationId: string): string => `${prefix}Send.v${version}.${lower(scope.userId)}.${lower(scope.organisationId)}.${lower(conversationId)}`;
const states: readonly PendingState[] = ['sending', 'uncertain', 'rate-limited', 'refused'];

/** This tab's sessionStorage, or null when the browser refuses it (private modes, disabled storage, quota). */
export function chatStorage(): StorageLike | null {
	try {
		if (typeof window === 'undefined') return null;
		const storage = window.sessionStorage;
		const probe = 'captain.storageProbe';
		storage.setItem(probe, '1'); storage.removeItem(probe);
		return storage;
	} catch { return null; }
}

/** Links in the order a create stores and sends them. */
export function sortLinks(links: { kind: LinkKind; targetId: string }[]): { kind: LinkKind; targetId: string }[] {
	return links.map((l) => ({ kind: l.kind, targetId: lower(l.targetId) }))
		.sort((a, b) => a.kind === b.kind ? (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0) : a.kind < b.kind ? -1 : 1);
}

function parse(text: string | null): Record<string, unknown> | null | 'none' {
	if (text === null) return 'none';
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch { return null; }
}
const exactKeys = (record: Record<string, unknown>, keys: string) => Object.keys(record).sort().join(',') === keys;
const sameScope = (record: Record<string, unknown>, scope: ChatScope) => record.v === version && record.userId === lower(scope.userId) && record.organisationId === lower(scope.organisationId);
const lowerId = (value: unknown): value is string => isClientId(value) && value === lower(value);
/** State fields, checked together: a rate-limited record has a wait, a refused one a code, and nothing else has either. */
function stateFields(record: Record<string, unknown>): { state: PendingState; retryAt: number | null; code: string | null } | null {
	const state = record.state as PendingState;
	if (!states.includes(state)) return null;
	const retryAt = record.retryAt, code = record.code;
	if (state === 'rate-limited' ? !(Number.isSafeInteger(retryAt) && (retryAt as number) > 0) : retryAt !== null) return null;
	if (state === 'refused' ? !(typeof code === 'string' && /^[a-z_]{1,64}$/.test(code)) : code !== null) return null;
	// A record left in `sending` means the page went away mid-request: whether it arrived is unknown.
	return { state: state === 'sending' ? 'uncertain' : state, retryAt: retryAt as number | null, code: code as string | null };
}

export function encodeSend(scope: ChatScope, conversationId: string, send: PendingSend): string {
	return JSON.stringify({ v: version, userId: lower(scope.userId), organisationId: lower(scope.organisationId), conversationId: lower(conversationId),
		id: send.id, body: send.body, state: send.state, retryAt: send.retryAt, code: send.code });
}

/** Read back a stored send, trusting nothing. A restored `sending` record comes back as `uncertain`. */
export function decodeSend(scope: ChatScope, conversationId: string, text: string | null): Restored<PendingSend> {
	const record = parse(text);
	if (record === 'none') return { state: 'none' };
	if (!record || !exactKeys(record, 'body,code,conversationId,id,organisationId,retryAt,state,userId,v') || !sameScope(record, scope)) return { state: 'invalid' };
	if (record.conversationId !== lower(conversationId) || !lowerId(record.id)) return { state: 'invalid' };
	if (typeof record.body !== 'string' || normaliseBody(record.body) !== record.body) return { state: 'invalid' };
	const fields = stateFields(record);
	if (!fields) return { state: 'invalid' };
	return { state: 'found', record: { id: record.id, body: record.body, ...fields } };
}

export function encodeCreate(scope: ChatScope, r: PendingCreate): string {
	return JSON.stringify({ v: version, userId: lower(scope.userId), organisationId: lower(scope.organisationId),
		id: r.id, title: r.title, participantIds: r.participantIds, links: r.links, state: r.state, retryAt: r.retryAt, code: r.code });
}

/** Read back a stored create, trusting nothing: the payload must already be the normalised form that is sent. */
export function decodeCreate(scope: ChatScope, text: string | null): Restored<PendingCreate> {
	const record = parse(text);
	if (record === 'none') return { state: 'none' };
	if (!record || !exactKeys(record, 'code,id,links,organisationId,participantIds,retryAt,state,title,userId,v') || !sameScope(record, scope)) return { state: 'invalid' };
	if (!lowerId(record.id) || typeof record.title !== 'string' || normaliseTitle(record.title) !== record.title) return { state: 'invalid' };
	const people = record.participantIds;
	if (!Array.isArray(people) || people.length > chatLimits.createOthersMax || !people.every((p) => isUuid(p) && p === lower(p) && p !== lower(scope.userId))) return { state: 'invalid' };
	if (JSON.stringify([...new Set(people)].sort()) !== JSON.stringify(people)) return { state: 'invalid' };
	const links = record.links;
	if (!Array.isArray(links) || links.length > chatLimits.linksMax) return { state: 'invalid' };
	if (!links.every((l) => l && typeof l === 'object' && !Array.isArray(l) && exactKeys(l as Record<string, unknown>, 'kind,targetId')
		&& ((l as Record<string, unknown>).kind === 'task' || (l as Record<string, unknown>).kind === 'project') && isUuid((l as Record<string, unknown>).targetId))) return { state: 'invalid' };
	const typed = links as { kind: LinkKind; targetId: string }[];
	const sorted = sortLinks(typed);
	if (JSON.stringify(sorted) !== JSON.stringify(typed) || new Set(typed.map((l) => `${l.kind}:${l.targetId}`)).size !== typed.length) return { state: 'invalid' };
	const fields = stateFields(record);
	if (!fields) return { state: 'invalid' };
	return { state: 'found', record: { id: record.id, title: record.title, participantIds: people as string[], links: typed, ...fields } };
}

function loadWith<T>(storage: StorageLike | null, key: string, decode: (text: string | null) => Restored<T>): Restored<T> {
	if (!storage) return { state: 'unavailable' };
	let text: string | null;
	try { text = storage.getItem(key); } catch { return { state: 'unavailable' }; }
	const restored = decode(text);
	// A malformed record is discarded, never shown or sent.
	if (restored.state === 'invalid') { try { storage.removeItem(key); } catch { /* reported as invalid either way */ } }
	return restored;
}
function saveWith(storage: StorageLike | null, key: string, text: string): boolean {
	if (!storage) return false;
	try { storage.setItem(key, text); return true; } catch { return false; }
}
function clearWith(storage: StorageLike | null, key: string): boolean {
	if (!storage) return false;
	try { storage.removeItem(key); return true; } catch { return false; }
}

export const loadSend = (storage: StorageLike | null, scope: ChatScope, conversationId: string): Restored<PendingSend> =>
	loadWith(storage, sendKey(scope, conversationId), (text) => decodeSend(scope, conversationId, text));
/** True only when the record is stored; the caller says so honestly when it is not. */
export const saveSend = (storage: StorageLike | null, scope: ChatScope, conversationId: string, send: PendingSend): boolean =>
	saveWith(storage, sendKey(scope, conversationId), encodeSend(scope, conversationId, send));
export const clearSend = (storage: StorageLike | null, scope: ChatScope, conversationId: string): boolean => clearWith(storage, sendKey(scope, conversationId));
export const loadCreate = (storage: StorageLike | null, scope: ChatScope): Restored<PendingCreate> => loadWith(storage, createKey(scope), (text) => decodeCreate(scope, text));
export const saveCreate = (storage: StorageLike | null, scope: ChatScope, r: PendingCreate): boolean => saveWith(storage, createKey(scope), encodeCreate(scope, r));
export const clearCreate = (storage: StorageLike | null, scope: ChatScope): boolean => clearWith(storage, createKey(scope));

/** What a pending record becomes after its request answered (handoff §6 table). `unchanged` covers results that sent
 *  nothing (wrong scope, no session, signed out): the record and its lock stay as they were. */
function nextState<R extends { state: PendingState; retryAt: number | null; code: string | null }>(r: R, result: ChatResult<unknown>, now: number): R | 'clear' {
	if (result.ok) return 'clear';
	switch (result.kind) {
		case 'rate-limited': return { ...r, state: 'rate-limited', retryAt: now + result.retryAfter * 1000, code: null };
		case 'uncertain': return { ...r, state: 'uncertain', retryAt: null, code: null };
		case 'id-unavailable': return { ...r, state: 'refused', retryAt: null, code: 'id_unavailable' };
		case 'refused': return { ...r, state: 'refused', retryAt: null, code: /^[a-z_]{1,64}$/.test(result.code) ? result.code : 'refused' };
		case 'stale': return { ...r, state: 'refused', retryAt: null, code: 'stale_revision' };
		case 'gone': return 'clear';
		case 'wrong-scope': case 'not-sent': case 'signed-out': return r;
	}
}
export const nextSendState = (send: PendingSend, result: ChatResult<Message>, now: number): PendingSend | 'clear' => nextState(send, result, now);
export const nextCreateState = (r: PendingCreate, result: ChatResult<ConversationDetail>, now: number): PendingCreate | 'clear' => nextState(r, result, now);

/** A send is confirmed once its id appears in a messages page or the change feed. */
export const sendSeen = (send: PendingSend, seenIds: ReadonlySet<string>): boolean => seenIds.has(send.id);
/** Whether the composer is locked: an unclear send stays locked until reconciled; others keep the draft editable. */
export const sendLocked = (send: PendingSend | null): boolean => !!send && (send.state === 'sending' || send.state === 'uncertain');

function keysOf(storage: StorageLike): string[] {
	const keys: string[] = [];
	if (typeof storage.length !== 'number' || typeof storage.key !== 'function') return keys;
	for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key !== null) keys.push(key); }
	return keys;
}
const chatKey = /^captain\.chat(?:Create|Send)\.v\d+\.([^.]+)\./;
function purge(storage: StorageLike | null, remove: (owner: string) => boolean): void {
	if (!storage) return;
	try { for (const key of keysOf(storage)) { const owner = chatKey.exec(key)?.[1]; if (owner && remove(owner)) storage.removeItem(key); } }
	catch { /* storage refused: nothing more can be removed from this tab */ }
}
/** Sign-out: every chat record of this person, in every organisation, before navigating away. */
export const purgeForUser = (storage: StorageLike | null, userId: string): void => purge(storage, (owner) => owner === lower(userId));
/** On load: records left by anyone other than the person now signed in. This person's other organisations are kept. */
export const purgeOtherUsers = (storage: StorageLike | null, userId: string): void => purge(storage, (owner) => owner !== lower(userId));
