import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GmailClient, htmlToText } from '../src/gmail.ts';
// Checked-in Gmail response fixtures use synthetic mailbox content; no customer's mail was captured.
const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
test('full threads prefer plain text and retain headers/attachment metadata without attachment data', async () => {
	const raw = await fixture('thread');
	const client = new GmailClient(async (url, init) => {
		assert.equal(new URL(String(url)).searchParams.get('format'), 'full');
		assert.deepEqual(init!.headers, { authorization: 'Bearer test-token' }); return Response.json(raw);
	});
	const thread = await client.thread('test-token', 'thread-1'); const message = thread.messages[0]!;
	assert.equal(message.body, 'Your delivery is on Thursday.'); assert.equal(message.inReplyTo, '<previous@example.test>');
	assert.equal(message.attachments.length, 2); assert.equal(message.attachments[0]!.providerAttachmentId, 'attachment-1');
	assert.ok(!JSON.stringify(thread).includes('ATTACHMENT-NEVER-STORE')); assert.ok(!JSON.stringify(thread).includes('data"'));
	assert.equal(message.fromHeader, 'Supplier <supplier@example.test>'); assert.equal(message.ccHeader, 'Crew <crew@example.test>');
});
test('HTML-only and external bodies remain honest, with no attachment endpoint calls', async () => {
	const raw = await fixture('thread'); const part = raw.messages[0].payload.parts[0].parts[1]; raw.messages[0].payload = part;
	part.body.data = Buffer.from('<head>hidden</head><script>bad()</script><style>bad</style><p>Hello &amp; crew<br>Friday &#x1f37a;</p>').toString('base64url');
	const client = new GmailClient(async () => Response.json(raw));
	assert.equal((await client.thread('x', 'thread-1')).messages[0]!.body, 'Hello & crew\nFriday 🍺');
	part.body = { attachmentId: 'external-body', size: 100000 };
	assert.equal((await client.thread('x', 'thread-1')).messages[0]!.bodyUnavailable, true);
	assert.equal(htmlToText('<p>&lt;img src=x onerror=bad()&gt;</p>'), '<img src=x onerror=bad()>'); // Still text, never HTML.
});
test('history includes deleted/labelled threads once and passes pagination and start cursor', async () => {
	const raw = await fixture('history');
	const client = new GmailClient(async (url) => {
		const query = new URL(String(url)).searchParams; assert.equal(query.get('startHistoryId'), '100'); assert.equal(query.get('pageToken'), 'next');
		return Response.json(raw);
	});
	assert.deepEqual(await client.history('x', '100', 'next'), { threadIds: ['thread-1', 'thread-deleted', 'thread-2'], historyId: '110', nextPageToken: 'history-page-2' });
});
test('profile, labels, recent-thread pagination, malformed responses and history 404', async () => {
	const client = new GmailClient(async (url) => {
		const u = new URL(String(url));
		if (u.pathname.endsWith('profile')) return Response.json({ emailAddress: 'Business@Example.test', historyId: '100' });
		if (u.pathname.endsWith('labels')) return Response.json({ labels: [{ id: 'Label_supplier', name: 'Suppliers' }] });
		assert.equal(u.searchParams.get('q'), 'after:123'); assert.equal(u.searchParams.get('pageToken'), 'next');
		return Response.json({ threads: [{ id: 'thread-1' }], nextPageToken: 'last' });
	});
	assert.equal((await client.profile('x')).historyId, '100'); assert.deepEqual(await client.labels('x'), { Label_supplier: 'Suppliers' });
	assert.deepEqual(await client.threads('x', 123, 'next'), { ids: ['thread-1'], nextPageToken: 'last' });
	await assert.rejects(new GmailClient(async () => Response.json({ historyId: 123 })).history('x', '100'), { status: 0 });
	await assert.rejects(new GmailClient(async () => new Response('sensitive', { status: 404 })).history('x', '100'), { status: 404, message: 'Gmail could not be read' });
});
