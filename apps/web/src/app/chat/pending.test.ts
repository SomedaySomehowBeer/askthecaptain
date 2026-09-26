import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toWriteFailure } from './results.ts';
import { ApiError } from '../../lib/api.ts';
import {
	clearCreate, clearSend, createKey, encodeCreate, encodeSend, loadCreate, loadSend, nextCreateState, nextSendState, purgeForUser,
	purgeOtherUsers, saveCreate, saveSend, sendKey, sendLocked, sendSeen, type PendingCreate, type PendingSend, type StorageLike
} from './pending.ts';
import type { ChatScope, ConversationDetail, Message } from './types.ts';

const user = '0199a1b2-0000-7000-8000-0000000000ee';
const scope: ChatScope = { userId: user, organisationId: '0199a1b2-0000-7000-8000-0000000000dd' };
const otherOrg: ChatScope = { userId: user, organisationId: '0199a1b2-0000-7000-8000-0000000000de' };
const pat: ChatScope = { userId: '0199a1b2-0000-7000-8000-0000000000ef', organisationId: scope.organisationId };
const cid = '0199a1b2-0000-7000-8000-0000000000c1';
const send: PendingSend = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', body: 'Slot confirmed for Thursday', state: 'sending', retryAt: null, code: null };
const create: PendingCreate = {
	id: '3f2504e0-4f89-41d3-9a0c-0305e82c3302', title: 'Packaging', participantIds: ['0199a1b2-0000-7000-8000-0000000000a1', '0199a1b2-0000-7000-8000-0000000000a2'],
	links: [{ kind: 'project', targetId: '0199a1b2-0000-7000-8000-0000000000b2' }, { kind: 'task', targetId: '0199a1b2-0000-7000-8000-0000000000b1' }],
	state: 'sending', retryAt: null, code: null
};

/** A tab's sessionStorage: survives a reload of the page, not the tab. */
function tab(): StorageLike & { map: Map<string, string> } {
	const map = new Map<string, string>();
	return {
		map, get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null,
		getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }
	};
}
const broken: StorageLike = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('SecurityError'); } };

test('keys are per person and organisation, and per conversation for sends', () => {
	assert.equal(createKey(scope), `captain.chatCreate.v1.${user}.${scope.organisationId}`);
	assert.equal(sendKey({ userId: user.toUpperCase(), organisationId: scope.organisationId }, cid.toUpperCase()), `captain.chatSend.v1.${user}.${scope.organisationId}.${cid}`);
});

test('a send is kept before it leaves; restored after reload it is locked as uncertain, with the same id and body', () => {
	const storage = tab();
	assert.deepEqual(loadSend(storage, scope, cid), { state: 'none' });
	assert.equal(saveSend(storage, scope, cid, send), true);
	const restored = loadSend(storage, scope, cid);
	assert.deepEqual(restored, { state: 'found', record: { ...send, state: 'uncertain' } });
	assert.equal(restored.state === 'found' && sendLocked(restored.record), true);
	assert.equal(clearSend(storage, scope, cid), true);
	assert.deepEqual(loadSend(storage, scope, cid), { state: 'none' });
});

test('one send record per conversation is shared by the thread and the item panel', () => {
	const storage = tab();
	saveSend(storage, scope, cid, send);
	// The panel loads the same key the thread wrote: its composer is blocked by the same pending send.
	const fromPanel = loadSend(storage, scope, cid);
	assert.equal(fromPanel.state, 'found');
	saveSend(storage, scope, cid, { ...send, id: '3f2504e0-4f89-41d3-9a0c-0305e82c3309', body: 'Second' });
	assert.equal(storage.map.size, 1, 'a second send replaces, never queues');
	assert.deepEqual(loadSend(storage, scope, '0199a1b2-0000-7000-8000-0000000000c2'), { state: 'none' });
});

test('a create is restored exactly, and a restored sending create is uncertain', () => {
	const storage = tab();
	assert.equal(saveCreate(storage, scope, create), true);
	assert.deepEqual(loadCreate(storage, scope), { state: 'found', record: { ...create, state: 'uncertain' } });
	const limited = { ...create, state: 'rate-limited' as const, retryAt: 1_900_000_000_000 };
	saveCreate(storage, scope, limited);
	assert.deepEqual(loadCreate(storage, scope), { state: 'found', record: limited });
	assert.equal(clearCreate(storage, scope), true);
	assert.deepEqual(loadCreate(storage, scope), { state: 'none' });
});

test('records are scoped and validated, never trusted; a malformed record is discarded', () => {
	const good = JSON.parse(encodeSend(scope, cid, send)) as Record<string, unknown>;
	const bad: unknown[] = ['not json', '[]', 'null', { ...good, v: 2 }, { ...good, extra: 1 }, { ...good, userId: pat.userId }, { ...good, conversationId: '0199a1b2-0000-7000-8000-0000000000c2' },
		{ ...good, id: send.id.toUpperCase() }, { ...good, id: '00000000-0000-0000-0000-000000000000' }, { ...good, body: '  padded ' }, { ...good, body: '' },
		{ ...good, body: 'x'.repeat(4001) }, { ...good, state: 'lost' }, { ...good, state: 'rate-limited' }, { ...good, state: 'refused' }, { ...good, retryAt: 5 },
		{ ...good, state: 'refused', code: 'Not A Code' }];
	for (const value of bad) {
		const storage = tab();
		storage.setItem(sendKey(scope, cid), typeof value === 'string' ? value : JSON.stringify(value));
		assert.deepEqual(loadSend(storage, scope, cid), { state: 'invalid' }, JSON.stringify(value));
		assert.equal(storage.map.size, 0, 'discarded');
	}
	const createGood = JSON.parse(encodeCreate(scope, create)) as Record<string, unknown>;
	const badCreates: unknown[] = [{ ...createGood, title: '' }, { ...createGood, title: ' Packaging' }, { ...createGood, participantIds: [...create.participantIds].reverse() },
		{ ...createGood, participantIds: [user] }, { ...createGood, participantIds: [create.participantIds[0], create.participantIds[0]] },
		{ ...createGood, participantIds: Array.from({ length: 50 }, (_, i) => `0199a1b2-0000-7000-8000-${String(i).padStart(12, '0')}`) },
		{ ...createGood, links: [...create.links].reverse() }, { ...createGood, links: [{ kind: 'series', targetId: create.links[0]!.targetId }] },
		{ ...createGood, links: [{ ...create.links[0], extra: 1 }] }, { ...createGood, links: [create.links[0], create.links[0]] }];
	for (const value of badCreates) {
		const storage = tab();
		storage.setItem(createKey(scope), JSON.stringify(value));
		assert.deepEqual(loadCreate(storage, scope), { state: 'invalid' }, JSON.stringify(value));
	}
	// Another person's or organisation's record is never read under this scope.
	const storage = tab();
	saveSend(storage, pat, cid, send);
	saveSend(storage, otherOrg, cid, send);
	assert.deepEqual(loadSend(storage, scope, cid), { state: 'none' });
	assert.doesNotMatch(encodeSend(scope, cid, send), /token|session|bearer/i);
});

const message = { id: send.id } as Message;
const detail = { id: create.id } as ConversationDetail;
const now = 1_800_000_000_000;

test('each result moves a pending send as the lifecycle table says', () => {
	assert.equal(nextSendState(send, { ok: true, value: message, requestId: null }, now), 'clear');
	assert.deepEqual(nextSendState(send, toWriteFailure<Message>(new ApiError(429, 'rate_limited', 'x', null, 7)), now), { ...send, state: 'rate-limited', retryAt: now + 7_000, code: null });
	const unclear = nextSendState(send, toWriteFailure<Message>(new ApiError(503, 'error', 'x', null)), now);
	assert.deepEqual(unclear, { ...send, state: 'uncertain', retryAt: null, code: null });
	assert.equal(unclear !== 'clear' && sendLocked(unclear), true);
	const taken = nextSendState(send, toWriteFailure<Message>(new ApiError(409, 'message_id_unavailable', 'x', null)), now);
	assert.deepEqual(taken, { ...send, state: 'refused', retryAt: null, code: 'id_unavailable' });
	assert.equal(taken !== 'clear' && sendLocked(taken), false, 'refused keeps the draft editable');
	assert.deepEqual(nextSendState(send, toWriteFailure<Message>(new ApiError(400, 'invalid_body', 'x', null)), now), { ...send, state: 'refused', retryAt: null, code: 'invalid_body' });
	assert.equal(nextSendState(send, toWriteFailure<Message>(new ApiError(404, 'not_found', 'x', null)), now), 'clear');
	const uncertainSend = { ...send, state: 'uncertain' as const };
	for (const kind of ['wrong-scope', 'not-sent', 'signed-out'] as const) {
		assert.deepEqual(nextSendState(uncertainSend, { ok: false, kind, retryAfter: null, requestId: null, error: 'x' }, now), uncertainSend, kind);
	}
	assert.equal(nextCreateState(create, { ok: true, value: detail, requestId: null }, now), 'clear');
	assert.deepEqual(nextCreateState(create, toWriteFailure<ConversationDetail>(new ApiError(409, 'conversation_id_unavailable', 'x', null)), now), { ...create, state: 'refused', retryAt: null, code: 'id_unavailable' });
});

test('a send clears once its id is seen in a page or the change feed', () => {
	assert.equal(sendSeen(send, new Set(['other'])), false);
	assert.equal(sendSeen(send, new Set([send.id])), true);
});

test('sign-out removes this person’s records everywhere; a new sign-in removes other people’s only', () => {
	const storage = tab();
	saveSend(storage, scope, cid, send); saveCreate(storage, scope, create); saveSend(storage, otherOrg, cid, send);
	saveSend(storage, pat, cid, send);
	storage.setItem('captain.savedViewCreate.v1.x.y', 'kept');
	purgeOtherUsers(storage, user);
	assert.equal(loadSend(storage, pat, cid).state, 'none');
	assert.equal(loadSend(storage, otherOrg, cid).state, 'found', 'another organisation of the same person is kept, not read');
	assert.equal(loadSend(storage, scope, cid).state, 'found');
	purgeForUser(storage, user.toUpperCase());
	assert.deepEqual([...storage.map.keys()], ['captain.savedViewCreate.v1.x.y']);
});

test('unavailable or failing storage is reported, never mistaken for "nothing pending"', () => {
	assert.equal(saveSend(null, scope, cid, send), false);
	assert.deepEqual(loadSend(null, scope, cid), { state: 'unavailable' });
	assert.equal(saveCreate(broken, scope, create), false);
	assert.deepEqual(loadCreate(broken, scope), { state: 'unavailable' });
	assert.equal(clearSend(broken, scope, cid), false);
	purgeForUser(broken, user);
	purgeForUser(null, user);
});
