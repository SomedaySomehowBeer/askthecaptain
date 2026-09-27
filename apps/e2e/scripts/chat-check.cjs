/** Local production web + workspace-fixture only (real API and Postgres). Linked chat, web slice D (the thread, its
 *  details and the task/project panels; the list, views and create are covered by chat-views-check.cjs):
 *  - thread: latest window, pins outside it, a visible hole between loaded ranges, header following renames;
 *  - polling: one changes page per tick, only while visible and focused (hidden and blurred tabs do not poll);
 *  - read position: from the displayed thread only, never from panels;
 *  - pending send, shared by thread and panel: uncertain, network failure, rate limited, restored after reload,
 *    cleared on access loss (live and initial 404) and on leaving, kept with its id across an expired session,
 *    purged by Settings sign-out and for other people on entry;
 *  - row, star and details writes: uncertain, unresolved (locked, read-only Check again), 429 waits, stale;
 *  - delete (own and moderator) and unpin through the UI, a deleted pinned message leaving the pins block;
 *  - details: rename, people (remove, add with the full-history note, leave), links (add, remove);
 *  - a late send answer after client navigation; 360/390/430/1440 layouts.
 *  The 10-minute idle stop and its resume are covered by poll unit tests, not here.
 *
 *  Start the fixture with WORKSPACE_PROBE_FAST_LIMITS=1. Needs from the fixture (root-owned): data.json `token`,
 *  `userId`, `orgId`, `base`, `memberToken`, `memberUserId`, `projectId`, `tasks`; `/__fixture/stats`
 *  `chatRequestCount` and `chatRequests[].sequence`; `mode` values chat-send-uncertain, chat-write-uncertain,
 *  chat-write-unresolved, chat-write-rate-limited, chat-send-rate-limited, chat-changes-failed. Polling waits are
 *  real (15 s cadence), so the run takes several minutes. Settings sign-out runs last: it ends the owner's session. */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:3034', directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw Error('WORKSPACE_PROBE_DIR required');
const POLL = 15000, TICK = { timeout: POLL * 2 + 5000 }, TOTAL = 120;
(async () => {
 const fixture = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(fixture.fixture, 'captain-workspace-local');
 assert.equal(fixture.fastRateWindows, true, 'chat fixture requires WORKSPACE_PROBE_FAST_LIMITS=1');
 for (const key of ['token', 'userId', 'orgId', 'base', 'memberToken', 'memberUserId', 'projectId', 'tasks']) assert.ok(fixture[key], `fixture ${key} required for chat`);
 const stats = async () => (await fetch('http://127.0.0.1:8084/__fixture/stats')).json();
 assert.equal(typeof (await stats()).chatRequestCount, 'number', 'restart the fixture: chatRequestCount and request sequence are required');
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 const signedIn = async token => {
  const made = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (process.env.CHROME_CDP_URL) await made.route(`${origin}/**`, async route => {
   const response = await route.fetch({ maxRedirects: 0 }), location = response.headers().location;
   if (location && response.status() >= 300 && response.status() < 400 && route.request().isNavigationRequest()) {
    const destination = new URL(location, route.request().url()).href;
    await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination).replace(/</g, '\\u003c')})</script>` });
   } else await route.fulfill({ response });
  });
  await made.addCookies([{ name: 'captain_session', value: token, url: origin }]);
  return made;
 };
 // Page errors and console errors both fail the run (hydration warnings included); aborted requests the script
 // causes on purpose are the only console errors expected.
 const errors = [], expectedConsole = /Failed to load resource|ERR_FAILED|ERR_ABORTED|Failed to fetch|status of (401|429|503)/;
 const opened = async context => {
  const p = await context.newPage(); p.setDefaultTimeout(15000);
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !expectedConsole.test(m.text())) errors.push(`console: ${m.text()}`); });
  return p;
 };
 const context = await signedIn(fixture.token), page = await opened(context);
 const patContext = await signedIn(fixture.memberToken), patPage = await opened(patContext);
 const pause = (ms = 1500) => new Promise(resolve => setTimeout(resolve, ms));
 /** Polling and read position need the page visible and focused; the two contexts share one browser. */
 const front = async (on = page) => { await on.bringToFront(); await on.evaluate(() => window.focus()); };
 const goto = async (route, on = page) => { await pause(); const r = await on.goto(origin + route); await front(on); return r; };
 const screenshot = async (options, on = page) => { await on.bringToFront(); return on.screenshot({ ...options, timeout: 30000 }); };
 const mode = value => writeFile(path.join(directory, 'mode'), value);
 const call = async (route, method = 'GET', body, token = fixture.token) => {
  const response = await fetch('http://127.0.0.1:8084' + fixture.base + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
 };
 const api = async (...args) => { const r = await call(...args); assert.ok(r.status < 300, `${args[1] ?? 'GET'} ${args[0]}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
 /** Chat API requests after `mark`: marks are the fixture's monotonic count, never positions in its 256-entry log. */
 const chatMark = async () => (await stats()).chatRequestCount;
 const chatSince = async mark => (await stats()).chatRequests.filter(r => r.sequence > mark);
 const changesSince = async (mark, conversationId) => (await chatSince(mark)).filter(r => r.method === 'GET' && r.path.endsWith(`/conversations/${conversationId}/changes`));
 const noOverflow = async (on = page) => assert.ok(await on.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${on.url()}`);
 const lower = s => s.toLowerCase();
 const sendKey = (userId, conversationId) => `captain.chatSend.v1.${lower(userId)}.${lower(fixture.orgId)}.${lower(conversationId)}`;
 const stored = (key, on = page) => on.evaluate(k => sessionStorage.getItem(k), key);
 const storedRecord = async (key, on = page) => { const text = await stored(key, on); return text === null ? null : JSON.parse(text); };
 const chatKeys = (on = page) => on.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('captain.chat')));
 const plant = (key, record, on = page) => on.evaluate(([k, v]) => sessionStorage.setItem(k, v), [key, JSON.stringify(record)]);
 const pendingFor = (userId, conversationId, body, state = 'uncertain') => ({ v: 1, userId: lower(userId), organisationId: lower(fixture.orgId), conversationId: lower(conversationId), id: randomUUID(), body, state, retryAt: null, code: null });
 const send = (conversationId, body, token = fixture.token) => api(`/conversations/${conversationId}/messages`, 'POST', { id: randomUUID(), body }, token);
 const messagesWith = async (conversationId, text) => {
  const found = []; let after = 0;
  for (;;) { const got = await api(`/conversations/${conversationId}/messages?after=${after}&limit=50`); found.push(...got.messages.filter(m => m.body === text)); if (!got.hasMore || got.messages.length === 0) break; after = got.messages.at(-1).seq; }
  return found;
 };
 const onlyMessage = async (conversationId, text) => { const found = await messagesWith(conversationId, text); assert.equal(found.length, 1, `exactly one "${text}"`); return found[0]; };
 /** Hide or blur the tab the way the poller sees it (visibilityState / hasFocus), and restore it. */
 const hide = (on = page) => on.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
 const unhide = async (on = page) => { await on.evaluate(() => { delete document.visibilityState; delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }); await front(on); };
 const blur = (on = page) => on.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
 const unblur = async (on = page) => { await on.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); }); await front(on); };
 const composer = (on = page) => on.locator('form.chat-compose--thread');
 const box = (on = page) => composer(on).locator('textarea');
 const stream = (on = page) => on.getByRole('list', { name: 'Messages' });
 /** A message row by its id: stable in edit mode, where the text lives in a textarea. */
 const byId = (id, on = page) => on.locator(`#message-${id}`);
 const menuOf = (id, on = page) => byId(id, on).getByRole('button', { name: /^Actions for / });
 const choose = async (id, action, on = page) => { await menuOf(id, on).click(); await on.getByRole('menuitem', { name: action, exact: true }).click(); };
 const pins = page.getByRole('region', { name: /Pinned for everyone/ });
 const panel = page.getByRole('region', { name: 'Chat' });
 const taskId = fixture.tasks['Confirm packaging slot'];
 let mark;
 try {
  await mode('');

  // Seed: a conversation with Pat, linked to a task and the project, 120 messages (every third by Pat), message 2
  // pinned: outside the latest-50 window (71–120) and far enough back that loading it leaves a hole (52–70).
  const main = await api('/conversations', 'POST', { id: randomUUID(), title: 'Launch floor', participantIds: [fixture.memberUserId], links: [{ kind: 'task', targetId: taskId }, { kind: 'project', targetId: fixture.projectId }] });
  const seeded = [];
  for (let i = 1; i <= TOTAL; i++) seeded.push(await send(main.id, i === TOTAL - 3 ? 'See https://example.com/spec (draft).' : `Seed message ${i}`, i % 3 === 0 ? fixture.memberToken : fixture.token));
  await api(`/conversations/${main.id}/pins`, 'POST', { messageId: seeded[1].id });
  const other = await api('/conversations', 'POST', { id: randomUUID(), title: 'Second room', participantIds: [fixture.memberUserId], links: [] });
  await send(other.id, 'Second room opener');
  console.log('PASS seeded conversations through the real API');

  // Thread: header, pins above the stream, only the latest window, the pinned message outside it has no row.
  mark = await chatMark();
  await goto(`/chat/${main.id}`);
  await expect(page.locator('.chat-title')).toContainText('Launch floor');
  await expect(page.locator('.chat-people')).toHaveText('Pat Baker, you');
  await expect(page.locator('.chat-links .chat-link')).toHaveCount(2);
  await expect(page.getByRole('link', { name: 'Details' })).toHaveAttribute('href', `/chat/${main.id}/details`);
  await expect(pins.locator('.chat-pin')).toHaveCount(1);
  await expect(pins.locator('.chat-pin')).toContainText('Seed message 2');
  await expect(pins.locator('.chat-pins__count')).toHaveText('1');
  assert.ok(await page.evaluate(() => { const p = document.querySelector('.chat-pins'), s = document.querySelector('.chat-stream'); return !!p && !!s && (p.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; }), 'pins sit above the stream');
  await expect(stream().locator('.chat-message')).toHaveCount(50);
  await expect(byId(seeded[1].id)).toHaveCount(0);
  await expect(byId(seeded[TOTAL - 1].id)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Earlier messages' })).toBeVisible();
  const shades = await stream().locator('.chat-message').evaluateAll(rows => rows.slice(0, 6).map(r => r.classList.contains('chat-message--alt')));
  assert.deepEqual(shades, [true, false, true, false, true, false]);
  await expect(stream().locator('.chat-day').first()).toBeVisible();
  await expect(byId(seeded[TOTAL - 4].id).getByRole('link', { name: 'https://example.com/spec' })).toHaveAttribute('href', 'https://example.com/spec');
  await expect(page.locator('.chat-plus')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(new RegExp(`\\b${TOTAL} messages\\b`));
  await expect(page.locator('.tabbar, .topnav').locator('.chat-row__unread')).toHaveCount(0);
  await front();
  await expect.poll(async () => (await api(`/conversations/${main.id}`)).lastReadSeq, TICK).toBe(TOTAL);
  assert.ok((await chatSince(mark)).some(r => r.method === 'POST' && r.path.endsWith(`/conversations/${main.id}/read`)));
  console.log('PASS thread header, pins above the latest window, no row for an out-of-window pin, read at the displayed tail');

  // Go to a pinned message far back: that range loads, the missing messages between ranges show as missing and fill
  // on request, and earlier pages add no duplicates.
  await pins.getByRole('button', { name: /Go to message/ }).click();
  await expect(byId(seeded[1].id)).toBeInViewport();
  await expect(byId(seeded[1].id)).toHaveClass(/chat-message--found/);
  const hole = stream().locator('.chat-gap');
  await expect(hole).toHaveCount(1);
  await expect(hole).toContainText('Messages not loaded');
  assert.equal(await page.evaluate(() => Number(document.querySelector('.chat-gap')?.previousElementSibling?.getAttribute('data-seq'))), 51);
  await hole.getByRole('button', { name: 'Show' }).click();
  await expect(hole).toHaveCount(0);
  while (await page.getByRole('button', { name: 'Earlier messages' }).count()) { await page.getByRole('button', { name: 'Earlier messages' }).click(); await pause(500); }
  await expect(stream().locator('.chat-message')).toHaveCount(TOTAL);
  assert.equal(new Set(await stream().locator('.chat-message').evaluateAll(rows => rows.map(r => r.id))).size, TOTAL);
  console.log('PASS go-to-message far back, a visible hole between ranges that fills, earlier pages without duplicates');

  // Hidden: no polling. Two messages sent meanwhile arrive on the single catch-up page when the tab returns.
  await goto(`/chat/${main.id}`);
  await pause(2000);
  await hide(); await pause(500);
  mark = await chatMark();
  const one = await send(main.id, 'Pat change one', fixture.memberToken);
  const two = await send(main.id, 'Pat change two', fixture.memberToken);
  await pause(POLL + 5000);
  assert.equal((await changesSince(mark, main.id)).length, 0, 'no polling while hidden');
  await unhide();
  await expect(byId(two.id)).toBeVisible();
  await expect(byId(one.id)).toBeVisible();
  let requests = await chatSince(mark);
  assert.equal((await changesSince(mark, main.id)).length, 1, 'both changes arrived on one catch-up page');
  assert.equal(requests.filter(r => r.method === 'GET' && r.path.endsWith(`/conversations/${main.id}/messages`)).length, 0, 'no gap fill');
  const seqs = await stream().locator('.chat-message').evaluateAll(rows => rows.map(r => Number(r.dataset.seq)));
  for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, 'contiguous seqs');
  // Blurred (visible but not focused): no polling either; focus resumes it.
  await blur(); await pause(500);
  mark = await chatMark();
  const blurred = await send(main.id, 'Sent while blurred', fixture.memberToken);
  await pause(POLL + 5000);
  assert.equal((await changesSince(mark, main.id)).length, 0, 'no polling while blurred');
  await unblur();
  await expect(byId(blurred.id)).toBeVisible(TICK);
  console.log('PASS hidden and blurred tabs do not poll; one catch-up page brings both changes; no gap');

  // A pin made elsewhere on an out-of-window message shows without a stream row; its unpin is not resurrected.
  const farPin = await api(`/conversations/${main.id}/pins`, 'POST', { messageId: seeded[4].id }, fixture.memberToken);
  await front();
  await expect(pins.locator('.chat-pin')).toHaveCount(2, TICK);
  await expect(byId(seeded[4].id)).toHaveCount(0);
  await api(`/conversations/${main.id}/pins/${farPin.id}`, 'DELETE', undefined, fixture.memberToken);
  await front();
  await expect(pins.locator('.chat-pin')).toHaveCount(1, TICK);
  console.log('PASS out-of-window pins update from changes without stream rows');

  // Failing changes: a quiet delayed note, then recovery.
  await mode('chat-changes-failed'); await front();
  await expect(page.getByText('New messages could not be checked just now. Captain will try again.')).toBeVisible(TICK);
  await mode('');
  const recovered = await send(main.id, 'After the outage', fixture.memberToken);
  await front();
  await expect(byId(recovered.id)).toBeVisible({ timeout: 90000 });
  await expect(page.getByText('New messages could not be checked just now.')).toHaveCount(0);
  console.log('PASS a failed changes read shows a delayed note and recovers');

  // Send; the record is stored before the request and cleared on confirmation.
  const mainKey = sendKey(fixture.userId, main.id);
  await box().fill('Thread hello'); await box().press('Control+Enter');
  await expect(stream()).toContainText('Thread hello');
  const hello = await onlyMessage(main.id, 'Thread hello');
  await expect(byId(hello.id)).toBeVisible();
  await expect.poll(() => stored(mainKey)).toBeNull();

  // A committed send whose response was lost is locked until its id is observed. Reload reads that id, so it
  // reconciles without another write and leaves exactly one message.
  await mode('chat-send-uncertain');
  await box().fill('Uncertain hello'); await composer().getByRole('button', { name: 'Send' }).click();
  await expect(composer()).toContainText('Captain could not confirm whether this was sent');
  await expect(box()).toHaveAttribute('readonly', '');
  let record = await storedRecord(mainKey);
  assert.equal(record.state, 'uncertain'); assert.equal(record.body, 'Uncertain hello'); assert.equal(JSON.stringify(record).match(/token|session/i), null);
  await mode(''); mark = await chatMark(); await page.reload(); await front();
  await expect(byId(record.id)).toBeVisible();
  await expect(box()).toHaveValue('');
  await expect(box()).not.toHaveAttribute('readonly', '');
  await expect(composer()).not.toContainText('could not confirm');
  assert.equal((await onlyMessage(main.id, 'Uncertain hello')).id, record.id);
  await expect.poll(() => stored(mainKey)).toBeNull();
  assert.equal((await chatSince(mark)).filter(r => r.method === 'POST' && r.path.endsWith(`/conversations/${main.id}/messages`)).length, 0, 'reload reconciles by reading, never resending');
  console.log('PASS a committed uncertain send reconciles on reload without a duplicate write');

  // A request lost before reaching the API has no confirmed id to reconcile. Its locked pending record survives
  // reload, is shared with the panel, and Try again sends the same id once.
  await page.route(`${origin}/chat/${main.id}`, route => route.request().method() === 'POST' && route.request().headers()['next-action'] ? route.abort() : route.fallback());
  mark = await chatMark();
  await box().fill('Dropped hello'); await composer().getByRole('button', { name: 'Send' }).click();
  await expect(composer()).toContainText('Captain could not confirm whether this was sent');
  await expect(box()).toHaveAttribute('readonly', '');
  record = await storedRecord(mainKey);
  assert.equal(record.state, 'uncertain');
  assert.equal((await chatSince(mark)).filter(r => r.method === 'POST' && r.path.endsWith(`/conversations/${main.id}/messages`)).length, 0);
  assert.equal((await messagesWith(main.id, 'Dropped hello')).length, 0);
  await page.unroute(`${origin}/chat/${main.id}`);
  await page.reload(); await front();
  await expect(box()).toHaveValue('Dropped hello');
  await expect(box()).toHaveAttribute('readonly', '');
  await goto(`/work/tasks/${taskId}`);
  await expect(panel.locator('form.chat-compose--panel textarea')).toHaveValue('Dropped hello');
  await expect(panel.locator('form.chat-compose--panel textarea')).toHaveAttribute('readonly', '');
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
  await goto(`/chat/${main.id}`);
  mark = await chatMark();
  await composer().getByRole('button', { name: 'Try again' }).click();
  await expect(byId(record.id)).toBeVisible();
  assert.equal((await chatSince(mark)).filter(r => r.method === 'POST' && r.path.endsWith(`/conversations/${main.id}/messages`)).length, 1);
  assert.equal((await onlyMessage(main.id, 'Dropped hello')).id, record.id);
  await expect.poll(() => stored(mainKey)).toBeNull();
  console.log('PASS a network failure survives reload, shares the pending send with the panel and resolves once');

  // Rate-limited send: nothing sent; editable with its id; blocked until Retry-After.
  await mode('chat-send-rate-limited');
  await box().fill('Too fast'); await composer().getByRole('button', { name: 'Send' }).click();
  await expect(composer()).toContainText('Too many messages just now');
  await expect(composer()).toContainText('nothing was sent');
  record = await storedRecord(mainKey);
  assert.equal(record.state, 'rate-limited'); assert.ok(record.retryAt > Date.now());
  await expect(box()).not.toHaveAttribute('readonly', '');
  await expect(composer().getByRole('button', { name: 'Send' })).toBeDisabled();
  assert.equal((await messagesWith(main.id, 'Too fast')).length, 0);
  await mode('');
  await expect(composer().getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 12000 });
  await composer().getByRole('button', { name: 'Send' }).click();
  await expect(byId(record.id)).toBeVisible();
  assert.equal((await onlyMessage(main.id, 'Too fast')).id, record.id, 'rate-limited send keeps its id');
  console.log('PASS rate-limited send keeps text and id, waits, then sends once');

  // Uncertain row writes reconcile by reading: edit, pin, star.
  await mode('chat-write-uncertain');
  await choose(hello.id, 'Edit');
  await byId(hello.id).locator('textarea').fill('Thread hello, edited');
  await byId(hello.id).getByRole('button', { name: 'Save' }).click();
  await expect(byId(hello.id)).toContainText('Saved.');
  await expect(byId(hello.id)).toContainText('Thread hello, edited');
  await expect(byId(hello.id).locator('.chat-message__edited')).toBeVisible();
  await choose(hello.id, 'Pin for everyone');
  await expect(byId(hello.id)).toContainText('Pinned.');
  await expect(pins.locator('.chat-pin')).toHaveCount(2);
  await page.locator('.chat-star').click();
  await expect(page.locator('.chat-star')).toHaveAttribute('aria-pressed', 'true');
  await mode('');
  assert.equal((await api(`/conversations/${main.id}`)).starred, true);
  assert.equal((await api(`/conversations/${main.id}/pins`)).pins.length, 2);
  // Keyboard menu: arrows move, Escape closes and returns focus.
  await menuOf(hello.id).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0); await expect(menuOf(hello.id)).toBeFocused();
  console.log('PASS uncertain edit, pin and star reconcile by reading; keyboard menu');

  // Unresolved (committed, answer and read-back both fail): the row keeps its intent and stays locked; Check again
  // only reads and unlocks only once the outcome is known. The thread is open before the mode fails reads.
  mark = await chatMark();
  await mode('chat-write-unresolved');
  await choose(hello.id, 'Edit');
  await byId(hello.id).locator('textarea').fill('Edited while unresolved');
  await byId(hello.id).getByRole('button', { name: 'Save' }).click();
  await expect(byId(hello.id).getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(byId(hello.id).locator('textarea')).toHaveAttribute('readonly', '');
  await expect(byId(hello.id).locator('textarea')).toHaveValue('Edited while unresolved');
  await expect(byId(hello.id).getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(byId(hello.id).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(menuOf(hello.id)).toHaveCount(0); // locked rows expose no menu actions
  await byId(hello.id).getByRole('button', { name: 'Check again' }).click(); // reads still fail: still locked
  await expect(byId(hello.id).getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(byId(hello.id).locator('textarea')).toHaveAttribute('readonly', '');
  await mode('');
  await byId(hello.id).getByRole('button', { name: 'Check again' }).click();
  await expect(byId(hello.id)).toContainText('Saved.');
  await expect(byId(hello.id)).toContainText('Edited while unresolved');
  await expect(menuOf(hello.id)).toBeEnabled();
  assert.equal((await chatSince(mark)).filter(r => r.method === 'PATCH' && r.path.endsWith(`/messages/${hello.id}`)).length, 1, 'Check again never repeats the edit');
  // Unpin through the UI, unresolved, then settled.
  await mode('chat-write-unresolved');
  await choose(hello.id, 'Unpin');
  await expect(byId(hello.id).getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(menuOf(hello.id)).toHaveCount(0); // locked rows expose no menu actions
  await mode('');
  await byId(hello.id).getByRole('button', { name: 'Check again' }).click();
  await expect(byId(hello.id)).toContainText('Unpinned.');
  await expect(pins.locator('.chat-pin')).toHaveCount(1);
  // Delete of a pinned message through the UI, unresolved, then settled: the pin leaves the pins block.
  const doomed = await send(main.id, 'Pinned then deleted');
  await front(); await expect(byId(doomed.id)).toBeVisible({ timeout: 75000 });
  await choose(doomed.id, 'Pin for everyone');
  await expect(pins.locator('.chat-pin')).toHaveCount(2);
  await mode('chat-write-unresolved');
  await choose(doomed.id, 'Delete');
  await byId(doomed.id).getByRole('group', { name: 'Delete this message' }).getByRole('button', { name: 'Delete' }).click();
  await expect(byId(doomed.id).getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(byId(doomed.id).getByRole('group', { name: 'Delete this message' }).getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await mode('');
  await byId(doomed.id).getByRole('button', { name: 'Check again' }).click();
  await expect(byId(doomed.id).locator('.chat-message__deleted')).toBeVisible();
  await expect(pins.locator('.chat-pin')).toHaveCount(1);
  await expect(pins).not.toContainText('Pinned then deleted');
  // The star, the same way.
  await mode('chat-write-unresolved');
  await page.locator('.chat-star').click();
  const header = page.locator('.chat-header');
  await expect(header.getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(page.locator('.chat-star')).toBeDisabled();
  await mode('');
  await header.getByRole('button', { name: 'Check again' }).click();
  await expect(header.getByRole('button', { name: 'Check again' })).toHaveCount(0);
  await expect(page.locator('.chat-star')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.chat-star')).toBeEnabled();
  assert.equal((await api(`/conversations/${main.id}`)).starred, false);
  console.log('PASS unresolved edit, unpin, delete and star stay locked with a read-only Check again');

  // Rate limited: nothing changes, and no further write before Retry-After (7 s).
  mark = await chatMark();
  await mode('chat-write-rate-limited');
  await choose(hello.id, 'Pin for everyone');
  await expect(byId(hello.id)).toContainText('Too many changes just now. Try again in 7 seconds');
  await expect(menuOf(hello.id)).toHaveCount(0); // locked rows expose no menu actions
  await mode('');
  await pause(3000);
  await expect(menuOf(hello.id)).toHaveCount(0); // locked rows expose no menu actions
  await expect(menuOf(hello.id)).toBeEnabled({ timeout: 8000 });
  assert.equal((await chatSince(mark)).filter(r => r.method === 'POST' && r.path.endsWith('/pins')).length, 1);
  assert.equal((await api(`/conversations/${main.id}/pins`)).pins.length, 1);
  await mode('chat-write-rate-limited');
  await page.locator('.chat-star').click();
  await expect(header).toContainText('Try again in 7 seconds');
  await expect(page.locator('.chat-star')).toBeDisabled();
  await mode('');
  await expect(page.locator('.chat-star')).toBeEnabled({ timeout: 10000 });
  assert.equal((await api(`/conversations/${main.id}`)).starred, false);
  console.log('PASS 429 on rows and the star: nothing changed, no write before the wait ends');

  // Moderator delete of someone else's message; unpin of the old pin through the UI.
  const patLast = seeded[TOTAL - 1];
  await choose(patLast.id, 'Delete');
  await byId(patLast.id).getByRole('group', { name: 'Delete this message' }).getByRole('button', { name: 'Delete' }).click();
  await expect(byId(patLast.id).locator('.chat-message__deleted')).toBeVisible();
  assert.ok((await api(`/conversations/${main.id}/messages?after=${patLast.seq - 1}&limit=1`)).messages[0].deletedAt);
  await pins.getByRole('button', { name: /Go to message/ }).click();
  await expect(byId(seeded[1].id)).toBeInViewport();
  await choose(seeded[1].id, 'Unpin');
  await expect(pins.locator('.chat-pin')).toHaveCount(0);
  assert.equal((await api(`/conversations/${main.id}/pins`)).pins.length, 0);
  await api(`/conversations/${main.id}/pins`, 'POST', { messageId: seeded[1].id }); // the panel checks use it again
  console.log('PASS moderator delete and UI unpin');

  // Stale edit: the current text is shown and the draft is kept.
  const current = (await api(`/conversations/${main.id}/messages?after=${hello.seq - 1}&limit=1`)).messages[0];
  await choose(hello.id, 'Edit');
  await byId(hello.id).locator('textarea').fill('My late edit');
  // Wait until the other edit has actually reached this browser through polling, then let React render it.
  // Saving must still use the revision from opening the editor, not silently accept the newly polled revision.
  await api(`/conversations/${main.id}/messages/${hello.id}`, 'PATCH', { expectedRevision: current.revision, body: 'Changed elsewhere' });
  await front();
  await expect(byId(hello.id).locator('.chat-edit__current')).toContainText('Changed elsewhere', { timeout: 75000 });
  await byId(hello.id).getByRole('button', { name: 'Save' }).click();
  await expect(byId(hello.id)).toContainText('This message changed since you opened it');
  await expect(byId(hello.id).locator('.chat-edit__current')).toContainText('Changed elsewhere');
  await expect(byId(hello.id).locator('textarea')).toHaveValue('My late edit');
  const afterConflict = (await api(`/conversations/${main.id}/messages?after=${hello.seq - 1}&limit=1`)).messages[0];
  await api(`/conversations/${main.id}/messages/${hello.id}`, 'PATCH', { expectedRevision: afterConflict.revision, body: 'Changed again before retry' });
  await expect(byId(hello.id).locator('.chat-edit__current')).toContainText('Changed again before retry', { timeout: 75000 });
  await byId(hello.id).getByRole('button', { name: 'Save' }).click();
  await expect(byId(hello.id)).toContainText('This message changed since you opened it');
  assert.equal((await api(`/conversations/${main.id}/messages?after=${hello.seq - 1}&limit=1`)).messages[0].body, 'Changed again before retry');
  await byId(hello.id).getByRole('button', { name: 'Cancel' }).click();
  // Delete confirmation also keeps the version the person chose, even after a live edit arrives.
  await choose(hello.id, 'Delete');
  const beforeDelete = (await api(`/conversations/${main.id}/messages?after=${hello.seq - 1}&limit=1`)).messages[0];
  await api(`/conversations/${main.id}/messages/${hello.id}`, 'PATCH', { expectedRevision: beforeDelete.revision, body: 'Changed during delete confirmation' });
  await expect(byId(hello.id).locator('.chat-confirm .chat-edit__current')).toContainText('Changed during delete confirmation', { timeout: 75000 });
  await byId(hello.id).getByRole('group', { name: 'Delete this message' }).getByRole('button', { name: 'Delete' }).click();
  await expect(byId(hello.id)).toContainText('This message changed since you chose Delete');
  assert.equal((await api(`/conversations/${main.id}/messages?after=${hello.seq - 1}&limit=1`)).messages[0].deletedAt, null);
  await byId(hello.id).getByRole('group', { name: 'Delete this message' }).getByRole('button', { name: 'Cancel' }).click();
  console.log('PASS stale edits and delete confirmations retain the reviewed revision across live updates and retries');

  // A rename made elsewhere reaches the header through the changes feed.
  const renamed = await api(`/conversations/${main.id}`);
  await api(`/conversations/${main.id}`, 'PATCH', { expectedRevision: renamed.revision, title: 'Launch floor (renamed)' });
  await front();
  await expect(page.locator('.chat-title')).toContainText('Launch floor (renamed)', TICK);
  await expect(page.getByText('The title, people or links changed. Updating…')).toHaveCount(0);
  console.log('PASS header follows a rename made elsewhere');

  // A late send answer after client-side navigation: the thread that sent it is gone from the screen, the next
  // conversation shows nothing of it and holds no record, and the send resolves once under its own conversation.
  await page.route(`${origin}/chat/${main.id}`, async route => {
   if (route.request().method() === 'POST' && route.request().headers()['next-action']) { await pause(5000); await route.fallback().catch(() => {}); }
   else await route.fallback().catch(() => {});
  });
  await box().fill('Late arrival'); await composer().getByRole('button', { name: 'Send' }).click();
  const sentAt = Date.now();
  const late = await storedRecord(mainKey);
  assert.equal(late.state, 'sending'); assert.equal(late.body, 'Late arrival');
  await page.getByRole('link', { name: 'Back to Chat' }).click(); // client navigation (next/link) to /chat
  await expect(page).toHaveURL(`${origin}/chat`);
  await page.locator('.chat-row').filter({ hasText: 'Second room' }).click();
  await expect(page).toHaveURL(`${origin}/chat/${other.id}`);
  await expect(page.locator('.chat-title')).toContainText('Second room');
  assert.ok(Date.now() - sentAt < 5000, 'the second conversation was on screen before the delayed answer (navigation was not held behind the action)');
  assert.equal((await messagesWith(main.id, 'Late arrival')).length, 0, 'the send had not reached Captain yet');
  await pause(7000); // the delayed answer lands while the second conversation is on screen
  await page.unroute(`${origin}/chat/${main.id}`);
  await expect(page.getByText('Late arrival')).toHaveCount(0);
  await expect(box()).toHaveValue('');
  assert.equal(await stored(sendKey(fixture.userId, other.id)), null);
  const landed = await onlyMessage(main.id, 'Late arrival');
  assert.equal(landed.id, late.id, 'the late send used its own id');
  await goto(`/chat/${main.id}`);
  await expect(byId(late.id)).toBeVisible();
  await expect.poll(() => stored(mainKey)).toBeNull();
  await expect(box()).toHaveValue('');
  console.log('PASS a late answer after client navigation never touches the next conversation and resolves once');

  // Panels: with a real unread baseline, visiting the task panel neither polls nor marks read.
  await goto(`/work/tasks/${taskId}`);
  const unseen = await send(main.id, 'Panel check target', fixture.memberToken);
  const baseline = await api(`/conversations/${main.id}`);
  assert.ok(baseline.lastReadSeq < baseline.lastSeq, 'the owner has unread messages before the panel is shown');
  mark = await chatMark();
  await goto(`/work/tasks/${taskId}`);
  await expect(panel.getByRole('heading', { name: 'Chat' })).toBeVisible();
  await expect(panel.getByRole('link', { name: /Open chat/ })).toHaveAttribute('href', `/chat/${main.id}`);
  await expect(panel.locator('.chat-row').first()).toContainText('Launch floor');
  await expect(panel.locator('.chat-pin')).toHaveCount(1);
  await expect(panel.locator('.chat-pin__go')).toHaveAttribute('href', `/chat/${main.id}#message-${seeded[1].id}`);
  await expect(panel.locator('.chat-message')).toHaveCount(6);
  await expect(panel.locator(`#message-${unseen.id}`)).toBeVisible();
  await pause(POLL + 5000);
  requests = await chatSince(mark);
  assert.equal(requests.filter(r => r.path.endsWith('/changes')).length, 0, 'panels never poll');
  assert.equal(requests.filter(r => r.path.endsWith('/read')).length, 0, 'panels never mark read');
  assert.equal((await api(`/conversations/${main.id}`)).lastReadSeq, baseline.lastReadSeq);
  const newer = await send(main.id, 'Panel newer', fixture.memberToken);
  await panel.getByRole('button', { name: 'Check for new messages' }).click();
  await expect(panel.locator(`#message-${newer.id}`)).toBeVisible();
  await panel.locator('form.chat-compose--panel textarea').fill('From the panel');
  await panel.locator('form.chat-compose--panel').getByRole('button', { name: 'Send' }).click();
  await expect(panel.locator('.chat-message').filter({ hasText: 'From the panel' })).toBeVisible();
  assert.equal((await api(`/conversations/${main.id}`)).lastReadSeq, baseline.lastReadSeq, 'sending from a panel does not mark read');
  // The panel's "Go to message" opens the thread at the pinned message far outside the latest window.
  await panel.locator('.chat-pin__go').click();
  await expect(page).toHaveURL(`${origin}/chat/${main.id}#message-${seeded[1].id}`);
  await expect(byId(seeded[1].id)).toBeInViewport();
  await expect(byId(seeded[1].id)).toHaveClass(/chat-message--found/);
  await expect(stream().locator('.chat-gap')).toHaveCount(1);
  await goto(`/work/projects/${fixture.projectId}`);
  await expect(panel.locator('.chat-row').first()).toContainText('Launch floor');
  await goto(`/work/projects/${fixture.projectId}?view=tasks`);
  await expect(panel).toHaveCount(0);
  const empty = fixture.tasks['Call the stockist'];
  await goto(`/work/tasks/${empty}`);
  await expect(panel.getByRole('link', { name: 'Start a conversation' })).toHaveAttribute('href', `/chat/new?link=task:${empty}`);
  console.log('PASS task and project panels: pins, latest six, check, send, Go to message; no polling, no read; overview only');

  // Details: rename, stale rename keeps the draft, unresolved rename locks with a read-only Check again, 429 waits.
  await goto(`/chat/${main.id}/details`);
  const title = page.getByLabel('Conversation title');
  await title.fill('Launch floor crew');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByText('Title saved.')).toBeVisible();
  const detailNow = await api(`/conversations/${main.id}`);
  await api(`/conversations/${main.id}`, 'PATCH', { expectedRevision: detailNow.revision, title: 'Renamed elsewhere' });
  await title.fill('My stale title');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Your choices are kept' })).toBeVisible();
  await expect(title).toHaveValue('My stale title');
  assert.equal((await api(`/conversations/${main.id}`)).title, 'Renamed elsewhere');
  mark = await chatMark();
  await mode('chat-write-unresolved');
  await page.getByRole('button', { name: 'Save title' }).click();
  const unconfirmed = page.getByRole('alert').filter({ hasText: 'Captain has not confirmed your last change' });
  await expect(unconfirmed).toBeVisible();
  await expect(title).toHaveValue('My stale title');
  await expect(page.getByRole('button', { name: 'Save title' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Leave conversation' })).toBeDisabled();
  await unconfirmed.getByRole('button', { name: 'Check again' }).click();
  // The notice stays visible while Checking. Wait for the failed read to settle before restoring the API;
  // otherwise the first check can succeed after the mode changes and there is correctly no second button.
  await expect(unconfirmed.getByRole('button', { name: 'Check again' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save title' })).toBeDisabled();
  await mode('');
  await unconfirmed.getByRole('button', { name: 'Check again' }).click();
  await expect(page.getByText('Title saved.')).toBeVisible();
  await expect(unconfirmed).toHaveCount(0);
  assert.equal((await chatSince(mark)).filter(r => r.method === 'PATCH' && r.path.endsWith(`/conversations/${main.id}`)).length, 1, 'checking never repeats the rename');
  assert.equal((await api(`/conversations/${main.id}`)).title, 'My stale title');
  await mode('chat-write-rate-limited');
  await title.fill('Too quick');
  await page.getByRole('button', { name: 'Save title' }).click();
  await expect(page.getByText('Too many changes just now. Try again in 7 seconds')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save title' })).toBeDisabled();
  await expect(title).toHaveValue('Too quick');
  await mode('');
  await expect(page.getByRole('button', { name: 'Save title' })).toBeEnabled({ timeout: 10000 });
  assert.equal((await api(`/conversations/${main.id}`)).title, 'My stale title');
  console.log('PASS details rename: stale keeps the draft, unresolved locks until read, 429 waits');

  // Links: add through the picker, remove.
  const linksSection = page.getByRole('region', { name: /Linked work/ });
  await expect(linksSection.getByRole('radio', { name: 'Task', exact: true })).toBeChecked();
  await linksSection.locator('summary').filter({ hasText: 'Find more tasks' }).click();
  await linksSection.getByLabel('Search by name').fill('Call the stockist');
  await linksSection.getByRole('button', { name: 'Search', exact: true }).click();
  const picker = linksSection.locator('select');
  await expect(picker.locator(`option[value="${fixture.tasks['Call the stockist']}"]`)).toHaveCount(1);
  await picker.selectOption(fixture.tasks['Call the stockist']);
  await linksSection.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByText('Linked.')).toBeVisible();
  assert.ok((await api(`/conversations/${main.id}`)).links.some(l => l.targetId === lower(fixture.tasks['Call the stockist'])));
  await linksSection.locator('li').filter({ hasText: 'Call the stockist' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Link removed.')).toBeVisible();
  assert.equal((await api(`/conversations/${main.id}`)).links.length, 2);
  console.log('PASS details links: add through the picker, remove');

  // People: removing Pat (owner) ends Pat's open thread, which clears Pat's unsent message there and shows nothing of
  // the conversation; adding Pat back shows the full-history note first.
  const patKey = sendKey(fixture.memberUserId, main.id);
  await goto(`/chat/${main.id}`, patPage);
  await plant(patKey, pendingFor(fixture.memberUserId, main.id, 'Pat unsent'), patPage);
  await patPage.reload(); await front(patPage);
  await expect(box(patPage)).toHaveValue('Pat unsent');
  await front();
  const people = page.getByRole('region', { name: /People/ });
  await people.locator('li').filter({ hasText: 'Pat Baker' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Pat Baker was removed.')).toBeVisible();
  await front(patPage);
  await expect(patPage.getByRole('heading', { name: 'This conversation is not available to you' })).toBeVisible(TICK);
  await expect(patPage.locator('main')).not.toContainText('Seed message');
  await expect.poll(() => stored(patKey, patPage)).toBeNull();
  await front();
  const add = page.getByRole('form', { name: 'Add people' });
  await expect(add).toContainText('People you add see the whole conversation, including everything said before they joined.');
  await add.getByLabel('Pat Baker').check();
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added.')).toBeVisible();
  await expect(people).toContainText('Pat Baker');
  assert.ok((await api(`/conversations/${main.id}`)).participants.some(p => lower(p.userId) === lower(fixture.memberUserId)));
  for (const width of [360, 390, 430, 1440]) { await page.setViewportSize({ width, height: 874 }); await noOverflow(); await screenshot({ path: path.join(directory, `chat-details-${width}.png`), fullPage: true }); }
  await page.setViewportSize({ width: 390, height: 844 });
  // Leaving clears this tab's unsent message for that conversation and returns to Chat.
  const leaving = await api('/conversations', 'POST', { id: randomUUID(), title: 'Leave me', participantIds: [fixture.memberUserId], links: [] });
  const leaveKey = sendKey(fixture.userId, leaving.id);
  await goto(`/chat/${leaving.id}/details`);
  await plant(leaveKey, pendingFor(fixture.userId, leaving.id, 'Never sent'));
  await page.getByRole('button', { name: 'Leave conversation' }).click();
  await expect(page).toHaveURL(`${origin}/chat`);
  assert.equal(await stored(leaveKey), null);
  assert.equal((await call(`/conversations/${leaving.id}`)).status, 404);
  console.log('PASS details people: remove ends access live and clears pending; add with the history note; leave clears pending');

  // An initial 404 clears that conversation's pending send and looks like any other unavailable conversation.
  const unknown = randomUUID(), unknownKey = sendKey(fixture.userId, unknown);
  await goto('/chat'); await plant(unknownKey, pendingFor(fixture.userId, unknown, 'Orphan'));
  await goto(`/chat/${unknown}`);
  await expect(page.getByRole('heading', { name: 'This conversation is not available to you' })).toBeVisible();
  await expect.poll(() => stored(unknownKey)).toBeNull();
  for (const width of [360, 1440]) { await page.setViewportSize({ width, height: 874 }); await noOverflow(); await screenshot({ path: path.join(directory, `chat-access-lost-${width}.png`) }); }
  await page.setViewportSize({ width: 390, height: 844 });
  console.log('PASS initial 404 clears the pending send');

  // Session expiry discovered by a background read locks every write, including forms already open. Drafts
  // remain visible, and keyboard submission cannot bypass the stopped state.
  await goto(`/chat/${main.id}`);
  await choose(hello.id, 'Edit');
  await byId(hello.id).locator('textarea').fill('Draft edit when session expires');
  await box().fill('Draft when polling expires');
  await context.clearCookies(); await front();
  await expect(page.getByRole('link', { name: 'Sign in again' })).toBeVisible(TICK);
  await expect(box()).toHaveValue('Draft when polling expires');
  await expect(box()).toHaveAttribute('readonly', '');
  await expect(composer().getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(page.locator('.chat-star')).toBeDisabled();
  await expect(byId(hello.id).locator('textarea')).toHaveValue('Draft edit when session expires');
  await expect(byId(hello.id).locator('textarea')).toHaveAttribute('readonly', '');
  await expect(byId(hello.id).getByRole('button', { name: 'Save' })).toBeDisabled();
  mark = await chatMark();
  await box().press('Control+Enter'); await pause(500);
  assert.equal((await chatSince(mark)).filter(r => r.method !== 'GET').length, 0, 'a keyboard shortcut cannot write after polling discovers expiry');
  await context.addCookies([{ name: 'captain_session', value: fixture.token, url: origin }]);
  await goto(`/work/tasks/${taskId}`);
  await plant(mainKey, pendingFor(fixture.userId, main.id, 'Panel pending across expiry'));
  await page.reload(); await front();
  await expect(panel.locator('form.chat-compose--panel textarea')).toHaveValue('Panel pending across expiry');
  const heldPanel = await storedRecord(mainKey);
  await context.clearCookies();
  await panel.getByRole('button', { name: 'Check for new messages' }).click();
  await expect(panel.getByRole('link', { name: 'Sign in again' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Try again' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Check for new messages' })).toBeDisabled();
  assert.equal((await storedRecord(mainKey)).id, heldPanel.id);
  await context.addCookies([{ name: 'captain_session', value: fixture.token, url: origin }]);
  await page.reload(); await front();
  await expect(panel.getByRole('button', { name: 'Discard' })).toBeEnabled();
  await panel.getByRole('button', { name: 'Discard' }).click();
  await expect.poll(() => stored(mainKey)).toBeNull();
  console.log('PASS polling and panel reads detect expiry, lock all controls and keep drafts and pending identities');

  // Expired session: the send is not made, the thread stops polling and locks with Sign in again, and this person's
  // records (this one and other conversations') are kept with their ids; after signing in the send resolves once.
  await goto(`/chat/${main.id}`);
  await plant(mainKey, pendingFor(fixture.userId, main.id, 'Kept across expiry'));
  await goto(`/chat/${other.id}`);
  await box().fill('After expiry');
  await expect(composer().getByRole('button', { name: 'Send' })).toBeEnabled();
  // Exercise expiry discovered by this write. The separately tested poll must not win the race and correctly
  // disable Send before the click; temporarily blur, then restore focus once the write has discovered expiry.
  await blur();
  await context.clearCookies();
  await composer().getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('link', { name: 'Sign in again' }).first()).toBeVisible();
  await unblur();
  await expect(composer().getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(box()).toHaveValue('After expiry');
  const expired = await storedRecord(sendKey(fixture.userId, other.id));
  assert.equal(expired.body, 'After expiry', 'the expired send keeps its record and id');
  assert.equal((await storedRecord(mainKey)).body, 'Kept across expiry', 'other conversations keep theirs');
  assert.equal((await messagesWith(other.id, 'After expiry')).length, 0);
  mark = await chatMark();
  await pause(POLL + 5000);
  assert.equal((await changesSince(mark, other.id)).length, 0, 'no polling after the session ended');
  await context.addCookies([{ name: 'captain_session', value: fixture.token, url: origin }]);
  await page.reload(); await front();
  await expect(box()).toHaveValue('After expiry');
  await composer().getByRole('button', { name: 'Try again' }).click();
  await expect(byId(expired.id)).toBeVisible();
  assert.equal((await onlyMessage(other.id, 'After expiry')).id, expired.id);
  console.log('PASS expired session: stops, locks, keeps records; the send resolves once with its id after signing in');

  // Layouts: thread (pins, composer above the tab bar, no floating button), panel, project overview.
  for (const [name, route] of [['thread', `/chat/${main.id}`], ['panel', `/work/tasks/${taskId}`], ['project', `/work/projects/${fixture.projectId}`]]) {
   for (const width of [360, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 874 }); await goto(route);
    // Next can briefly retain hidden incoming markup alongside a loading screen. Measure the rendered content.
    if (name === 'thread') {
     await expect(page.locator('.chat-header')).toBeVisible();
     await expect(composer()).toBeVisible();
    } else {
     await expect(panel.locator('.chat-message')).toHaveCount(6);
     await expect(panel.locator('form.chat-compose--panel')).toBeVisible();
    }
    await noOverflow();
    if (name === 'thread') {
     const layout = await page.evaluate(() => { const c = document.querySelector('.chat-compose--thread')?.getBoundingClientRect(), t = document.querySelector('.tabbar')?.getBoundingClientRect(); return { composer: c?.bottom ?? 0, tabbar: t && t.height ? t.top : innerHeight }; });
     assert.ok(layout.composer <= layout.tabbar + 1, `composer clears the tab bar at ${width}`);
     await expect(page.locator('.chat-header')).toBeVisible();
     await expect(page.locator('.chat-plus')).toHaveCount(0);
     await expect(page.getByRole('link', { name: 'Back to Chat' })).toBeVisible();
    }
    await screenshot({ path: path.join(directory, `chat-${name}-${width}.png`), fullPage: name !== 'thread' });
   }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  console.log('PASS 360/390/430/1440 layouts');

  // Last, because it ends the owner's session: Settings sign-out purges every chat record of this person in the tab
  // (including the one kept across the expired session); entering chat already purged other people's.
  await goto(`/chat/${other.id}`);
  await plant(sendKey(fixture.userId, other.id), pendingFor(fixture.userId, other.id, 'Before sign out'));
  await plant(sendKey(fixture.memberUserId, other.id), pendingFor(fixture.memberUserId, other.id, 'Someone else'));
  await page.reload(); await front();
  await expect.poll(() => stored(sendKey(fixture.memberUserId, other.id))).toBeNull();
  assert.ok(await stored(mainKey), 'the record kept across the expired session is still here before sign-out');
  await goto('/settings');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).not.toHaveURL(/\/settings/);
  assert.deepEqual(await chatKeys(), []);
  console.log('PASS Settings sign-out purges this person\'s chat records; entry purges other people\'s');

  assert.deepEqual(errors, []);
 } catch (error) { await screenshot({ path: path.join(directory, 'chat-failure.png'), fullPage: true }).catch(() => {}); console.error('PAGE', page.url(), await page.locator('main').innerText().catch(() => '')); throw error; }
 finally { await mode('').catch(() => {}); await patContext.close().catch(() => {}); await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
