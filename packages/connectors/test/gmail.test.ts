import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GmailClient, GmailError, htmlToText } from '../src/gmail.ts';
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
	assert.equal(message.bccHeader, 'Private <private@example.test>');
	assert.equal(message.listUnsubscribe, true); assert.equal(message.precedence, 'bulk'); assert.equal(message.listId, ''); assert.equal(message.autoSubmitted, '');
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

test('watch and stop use Gmail POST endpoints and validate the returned expiry', async () => {
 const calls: { url: string; method?: string; body: unknown }[] = [];
 const client = new GmailClient(async (input, init) => {
  calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
  return String(input).endsWith('/stop') ? new Response(null, { status: 204 }) : Response.json({ historyId: '987', expiration: '1800000000000' });
 });
 assert.deepEqual(await client.watch('token', 'projects/project-test/topics/mail'), { historyId: '987', expiration: 1800000000000 });
 await client.stop('token'); assert.equal(calls[0]!.method, 'POST'); assert.deepEqual(calls[0]!.body, { topicName: 'projects/project-test/topics/mail' }); assert.match(calls[1]!.url, /\/users\/me\/stop$/);
 await assert.rejects(new GmailClient(async () => Response.json({ historyId: '1', expiration: 'bad' })).watch('token', 'topic'), GmailError);
});

test('errors name Google\'s reason and the fetch outcome, but never provider text', async () => {
	const forbidden = () => Response.json({ error: { code: 403, message: 'Gmail API has not been used in project 123 before', status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits', message: 'secret detail' }] } }, { status: 403 });
	await assert.rejects(new GmailClient(async () => forbidden()).profile('t'), (e: unknown) => e instanceof GmailError && e.status === 403 && e.reason === 'accessNotConfigured' && !/project|secret/.test(JSON.stringify(e)));
	const unknown = () => Response.json({ error: { code: 403, status: 'MADE_UP', errors: [{ reason: 'privateReasonText' }] } }, { status: 403 });
	await assert.rejects(new GmailClient(async () => unknown()).profile('t'), (e: unknown) => e instanceof GmailError && e.status === 403 && e.reason === '');
	await assert.rejects(new GmailClient(async () => new Response('<html>sensitive</html>', { status: 502 })).profile('t'), { status: 502, reason: '' });
	await assert.rejects(new GmailClient(async () => { throw new DOMException('aborted', 'TimeoutError'); }).profile('t'), { status: 0, reason: 'timeout' });
	await assert.rejects(new GmailClient(async () => { throw new TypeError('fetch failed'); }).profile('t'), { status: 0, reason: 'network' });
	await assert.rejects(new GmailClient(async () => Response.json({ historyId: 123 })).history('x', '100'), { status: 0, reason: 'unreadable' });
});
test('one message with an unknown charset or NUL bytes does not stop the mailbox', async () => {
	const raw = await fixture('thread'); const message = raw.messages[0]; const part = message.payload.parts[0].parts[0]; const nul = String.fromCharCode(0);
	part.headers = [{ name: 'Content-Type', value: 'text/plain; charset=x-not-a-charset' }]; part.body.data = Buffer.from(`Plain enough${nul} text`).toString('base64url');
	message.snippet = `Snip${nul}pet`; message.payload.headers.push({ name: 'Subject', value: `Odd${nul} subject` });
	const thread = await new GmailClient(async () => Response.json(raw)).thread('x', 'thread-1');
	assert.equal(thread.messages[0]!.body, 'Plain enough text'); assert.equal(thread.messages[0]!.snippet, 'Snippet');
	assert.ok(!JSON.stringify(thread).includes(nul));
});

test('rate limits and Google 5xx reads back off and retry; permission errors and write failures do not', async () => {
	const sleeps: number[] = []; const sleep = async (ms: number) => { sleeps.push(ms); };
	let answers = [429, 403, 200]; const rateLimited = () => { const status = answers.shift()!; return status === 200 ? Response.json({ emailAddress: 'a@b.test', historyId: '1' }) : Response.json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { status }); };
	assert.equal((await new GmailClient(async () => rateLimited(), { sleep, retries: 4 }).profile('t')).historyId, '1'); assert.equal(sleeps.length, 2);
	assert.ok(sleeps[0]! >= 1000 && sleeps[0]! < 1250 && sleeps[1]! >= 2000 && sleeps[1]! < 2250, 'exponential with jitter');
	sleeps.length = 0; answers = [429, 429, 429];
	await assert.rejects(new GmailClient(async () => rateLimited(), { sleep, retries: 2 }).profile('t'), { status: 429 }); assert.equal(sleeps.length, 2);
	sleeps.length = 0; await assert.rejects(new GmailClient(async () => Response.json({ error: { errors: [{ reason: 'accessNotConfigured' }] } }, { status: 403 }), { sleep }).profile('t'), { status: 403 }); assert.equal(sleeps.length, 0);
	sleeps.length = 0; let reads = 0; assert.equal((await new GmailClient(async () => ++reads === 1 ? new Response('down', { status: 503 }) : Response.json({ emailAddress: 'a@b.test', historyId: '2' }), { sleep }).profile('t')).historyId, '2'); assert.equal(sleeps.length, 1);
	sleeps.length = 0; let sends = 0; await assert.rejects(new GmailClient(async () => { sends++; return new Response('down', { status: 500 }); }, { sleep }).send('t', 'raw'), { status: 500 }); assert.equal(sends, 1, 'a send is never repeated after an unknown outcome'); assert.equal(sleeps.length, 0);
});
