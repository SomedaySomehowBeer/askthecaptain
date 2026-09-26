import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatListHref, chatViewLinks, parseChatListUrl, shownGroups, type ChatList } from './list-url.ts';

const parsed = (search: Record<string, string | string[] | undefined>): ChatList => {
	const u = parseChatListUrl(search);
	assert.ok(u.ok, JSON.stringify(u));
	const { ok: _, ...list } = u;
	return list;
};

test('defaults: all conversations, both groups, first pages', () => {
	assert.deepEqual(parseChatListUrl({}), { ok: true, filter: 'all', linked: null, cursors: { work: null, team: null } });
	assert.equal(chatListHref(parsed({})), '/chat');
	assert.equal(chatListHref(parsed({ filter: 'all' })), '/chat', 'the default filter is left out');
	assert.deepEqual(shownGroups(parsed({})).map((g) => g.title), ['About the work', 'Team conversations']);
});

test('a linked view shows only its group', () => {
	assert.deepEqual(shownGroups(parsed({ linked: 'true' })).map((g) => g.key), ['work']);
	assert.deepEqual(shownGroups(parsed({ linked: 'false' })).map((g) => g.key), ['team']);
});

test('each group pages on its own cursor and keeps the other group’s place', () => {
	const u = parsed({ filter: 'unread', work: 'W1' });
	assert.equal(chatListHref(u, { team: 'T1' }), '/chat?filter=unread&work=W1&team=T1');
	assert.equal(chatListHref(parsed({ work: 'W1', team: 'T1' }), { work: 'W2' }), '/chat?work=W2&team=T1');
	assert.equal(chatListHref(parsed({ work: 'W1', team: 'T1' }), { work: null }), '/chat?team=T1');
});

test('changing the filter or the linked view starts both groups again', () => {
	const u = parsed({ filter: 'unread', work: 'W1', team: 'T1' });
	assert.equal(chatListHref(u, { filter: 'starred' }), '/chat?filter=starred');
	assert.equal(chatListHref(u, { linked: true }), '/chat?filter=unread&linked=true');
	assert.equal(chatListHref(parsed({ linked: 'true', work: 'W1' }), { filter: 'all' }), '/chat?linked=true&work=W1', 'no change keeps the place');
	assert.equal(chatListHref(parsed({ linked: 'false' }), { linked: null }), '/chat');
});

test('repeated, unknown or malformed settings are refused rather than guessed', () => {
	for (const search of [{ filter: ['all', 'unread'] }, { sort: 'new' }, { filter: 'inbox' }, { linked: 'yes' }, { work: 'not a cursor!' },
		{ work: 'x'.repeat(301) }, { linked: 'true', team: 'T1' }, { linked: 'false', work: 'W1' }]) {
		const u = parseChatListUrl(search);
		assert.equal(u.ok, false, JSON.stringify(search));
		assert.ok(!u.ok && u.problem.length > 0);
	}
});

test('chat views are filter and linked pairs, never counts', () => {
	assert.deepEqual(chatViewLinks.map((v) => [v.group, v.label, v.href]), [
		['Conversations', 'All conversations', '/chat'], ['Conversations', 'Unread', '/chat?filter=unread'], ['Conversations', 'Starred', '/chat?filter=starred'],
		['Linked to work', 'Linked', '/chat?linked=true'], ['Linked to work', 'Not linked', '/chat?linked=false']
	]);
	for (const v of chatViewLinks) { assert.doesNotMatch(v.detail, /\d/); assert.ok(parseChatListUrl(Object.fromEntries(new URL(v.href, 'http://x').searchParams)).ok); }
});
