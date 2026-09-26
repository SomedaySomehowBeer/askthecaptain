/** Local production web + workspace-fixture only (real API and Postgres). Linked chat web slice D, business-views
 *  part: the conversation list and its views, and New conversation.
 *  - List: empty states, failed reads (`chat-list-failed`), unusable links and cursors, All/Unread/Starred ×
 *    About the work/Team conversations with more than 50 matching conversations per group, independent cursors.
 *    Each group's rows are checked against the API's own page for the same view.
 *  - Views: two groups, pairs of filter and linked, no counts, the green plus.
 *  - New: the editable `?link=` default, people, links through the Work picker, Pat seeing the result, an uncertain
 *    create (`chat-create-uncertain`) resolved by the same id, `conversation_id_unavailable` needing Start again, a
 *    create refused under another organisation (other-tab switch) and under an expired session, both keeping the
 *    create's id for the scope it belongs to.
 *  - Signed out: list, views, new, thread and details links send sign-in a canonical return_to (unusable links return
 *    plainly), and once signed in that sign-in URL lands on exactly that destination.
 *  - Layouts at 360/390/430/1440; page errors and console errors fail the run.
 *
 *  Needs a FRESH fixture started with WORKSPACE_PROBE_FAST_LIMITS=1 (the owner must start with no conversations), and
 *  from it (root-owned): data.json `token`, `userId`, `orgId`, `base`, `memberToken`, `memberUserId`, `projectId`,
 *  `tasks`; `/__fixture/stats` `chatRequestCount` and `chatRequests[].sequence`; `mode` values chat-list-failed and
 *  chat-create-uncertain.
 *
 *  Not covered here (said plainly rather than implied): the loading skeleton (too brief to observe reliably), the
 *  49-other-people cap (the fixture has one other member), a rate-limited create (no fixture mode reaches
 *  POST …/conversations with 429; the restore of a rate-limited record is exercised by planting one), and the thread,
 *  details and panels (chat-check.cjs). */
const { chromium, expect } = require('@playwright/test');
const { readFile, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:3034', apiOrigin = 'http://127.0.0.1:8084', directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw Error('WORKSPACE_PROBE_DIR required');
(async () => {
 const fixture = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
 assert.equal(fixture.fixture, 'captain-workspace-local');
 assert.equal(fixture.fastRateWindows, true, 'chat views fixture requires WORKSPACE_PROBE_FAST_LIMITS=1');
 const stats = async () => (await fetch(`${apiOrigin}/__fixture/stats`)).json();
 assert.equal(typeof (await stats()).chatRequestCount, 'number', 'restart the fixture: chatRequestCount and request sequence are required');
 for (const key of ['token', 'userId', 'orgId', 'base', 'memberToken', 'memberUserId', 'projectId', 'tasks']) assert.ok(fixture[key], `fixture ${key} required for chat views`);
 const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
 /** Every context signs in with a cookie and, when the shared Chrome runs in Docker (CHROME_CDP_URL), forwards
  *  loopback requests through Node, including HTTP redirects as fresh navigations (as the other workspace checks). */
 /** `token` null gives a signed-out context (for return_to checks). */
 const signedIn = async token => {
  const made = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (process.env.CHROME_CDP_URL) await made.route(`${origin}/**`, async route => {
   const response = await route.fetch({ maxRedirects: 0 }), location = response.headers().location;
   if (location && response.status() >= 300 && response.status() < 400 && route.request().isNavigationRequest()) {
    const destination = new URL(location, route.request().url()).href;
    await route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination).replace(/</g, '\\u003c')})</script>` });
   } else await route.fulfill({ response });
  });
  if (token !== null) await made.addCookies([{ name: 'captain_session', value: token, url: origin }]);
  return made;
 };
 const errors = [];
 const opened = async context => {
  const p = await context.newPage(); p.setDefaultTimeout(15000);
  p.on('pageerror', e => errors.push(`pageerror ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`console ${m.text()}`); });
  return p;
 };
 const context = await signedIn(fixture.token), page = await opened(context);
 const patContext = await signedIn(fixture.memberToken), patPage = await opened(patContext);
 const pause = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));
 const goto = async (route, on = page) => { await pause(); const r = await on.goto(origin + route); await on.bringToFront(); return r; };
 const screenshot = async (options, on = page) => { await on.bringToFront(); return on.screenshot({ ...options, timeout: 30000 }); };
 const mode = value => writeFile(path.join(directory, 'mode'), value);
 const call = async (route, method = 'GET', body, token = fixture.token, base = fixture.base) => {
  const response = await fetch(apiOrigin + base + route, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
 };
 const api = async (...args) => { const r = await call(...args); assert.ok(r.status < 300, `${args[1] ?? 'GET'} ${args[0]}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
 /** One API page of a view, exactly as the list page asks for it. */
 const apiPage = (filter, linked, cursor = null, token = fixture.token) =>
  api(`/conversations?${new URLSearchParams({ filter, linked: String(linked), limit: '50', ...(cursor ? { cursor } : {}) })}`, 'GET', undefined, token);
 /** Every conversation of the owner in the default view (all pages), from the API. */
 const allConversations = async (base = fixture.base) => {
  const found = []; let cursor = null;
  do { const p = await api(`/conversations?${new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })}`, 'GET', undefined, fixture.token, base); found.push(...p.conversations); cursor = p.nextCursor; } while (cursor);
  return found;
 };
 const titled = async (title, base) => (await allConversations(base)).filter(c => c.title === title);
 const chatMark = async () => (await stats()).chatRequestCount;
 const createsSince = async mark => (await stats()).chatRequests.filter(r => r.sequence > mark && r.method === 'POST' && r.path === `${fixture.base}/conversations`);
 const noOverflow = async (on = page) => assert.ok(await on.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `overflow at ${on.url()}`);
 // The accessible main landmark only: while a page streams under chat/loading.tsx, Next keeps the incoming page's
 // <main> hidden next to the visible loading one, so a plain CSS `main` can match two and fail strict mode at once.
 // The role locator ignores the hidden one and retries until the real content is swapped in.
 const main = (on = page) => on.getByRole('main');
 /** The All/Unread/Starred chips of the page on screen (role locators skip the hidden, still-streaming copy). */
 const chipNav = (on = page) => main(on).getByRole('navigation', { name: 'Show' });
 const group = (title, on = page) => on.getByRole('region', { name: title, exact: true });
 const rowIds = async (title, on = page) => on.getByRole('list', { name: title, exact: true }).locator('a.chat-row')
  .evaluateAll(links => links.map(a => a.getAttribute('href').split('/').pop()));
 const lower = s => s.toLowerCase();
 const createKey = orgId => `captain.chatCreate.v1.${lower(fixture.userId)}.${lower(orgId)}`;
 const storedRecord = async (key, on = page) => { const text = await on.evaluate(k => sessionStorage.getItem(k), key); return text === null ? null : JSON.parse(text); };
 const plant = (key, record, on = page) => on.evaluate(([k, v]) => sessionStorage.setItem(k, v), [key, JSON.stringify(record)]);
 const useOrganisation = id => context.addCookies([{ name: 'captain_organisation', value: id, url: origin }]);
 const title = () => page.getByLabel('Title', { exact: true });
 const startButton = () => page.getByRole('button', { name: 'Start conversation', exact: true });
 const taskId = fixture.tasks['Confirm packaging slot'];
 const expectThread = async id => { await expect(page).toHaveURL(`${origin}/chat/${id}`); };
 const newThreadId = () => new URL(page.url()).pathname.split('/').pop();
 try {
  await mode('');
  await useOrganisation(fixture.orgId);
  assert.equal((await allConversations()).length, 0, 'a fresh fixture: the owner starts with no conversations');

  // Signed out, a Chat deep link goes to sign-in with the canonical form of that exact view or suggestion to return
  // to; an unusable link returns to the plain page rather than carrying the bad values.
  // Then, signed in, that sign-in URL sends the person to exactly that destination (the sign-in page redirects a
  // signed-in visitor to a safe return_to), and the destination renders what it names.
  const anonymous = await signedIn(null), outPage = await opened(anonymous);
  const someConversation = randomUUID();
  for (const [route, returnTo, arrived] of [
   ['/chat?linked=false&filter=unread&team=abc', '/chat?filter=unread&linked=false&team=abc',
    async () => { await expect(outPage.locator('.chat-filter[aria-current="page"]')).toHaveText('Unread'); await expect(group('About the work', outPage)).toHaveCount(0); await expect(group('Team conversations', outPage)).toBeVisible(); }],
   ['/chat?filter=all&work=W1', '/chat?work=W1',
    async () => { await expect(group('About the work', outPage)).toContainText('That page cursor cannot be read.'); }],
   ['/chat?filter=inbox', '/chat',
    async () => { await expect(main(outPage).getByRole('heading', { name: 'No conversations yet' })).toBeVisible(); }],
   ['/chat/views', '/chat/views',
    async () => { await expect(group('Linked to work', outPage)).toBeVisible(); }],
   [`/chat/new?link=task:${taskId}`, `/chat/new?link=task%3A${taskId}`,
    async () => { await expect(outPage.getByRole('list', { name: 'Linked tasks and projects' })).toContainText('Task: Confirm packaging slot'); }],
   ['/chat/new?link=task:nope', '/chat/new',
    async () => { await expect(outPage.getByText('Not linked to any task or project.')).toBeVisible(); }],
   [`/chat/${someConversation}`, `/chat/${someConversation}`,
    async () => { await expect(outPage.getByRole('heading', { name: 'This conversation is not available to you' })).toBeVisible(); }],
   [`/chat/${someConversation}/details`, `/chat/${someConversation}/details`,
    async () => { await expect(outPage.getByRole('heading', { name: 'This conversation is not available to you' })).toBeVisible(); }]
  ]) {
   await anonymous.clearCookies();
   await goto(route, outPage);
   await expect(outPage).toHaveURL(/\/sign-in\?/);
   const signIn = outPage.url();
   assert.equal(new URL(signIn).searchParams.get('return_to'), returnTo, `return_to for ${route}`);
   await anonymous.addCookies([{ name: 'captain_session', value: fixture.token, url: origin }]);
   await outPage.goto(signIn);
   await expect(outPage).toHaveURL(origin + returnTo);
   await arrived();
  }
  await anonymous.close();
  console.log('PASS signed-out list, views, new, thread and details links return to their canonical destination after sign-in');

  // Empty states: one designed notice per view, no counts, the plus on the list.
  await goto('/chat');
  await expect(main().getByRole('heading', { name: 'No conversations yet' })).toBeVisible();
  await expect(main().getByRole('link', { name: 'Start a conversation' })).toHaveAttribute('href', '/chat/new');
  await expect(page.locator('.chat-filter[aria-current="page"]')).toHaveText('All');
  await expect(page.getByRole('link', { name: 'Back to Views' })).toHaveAttribute('href', '/chat/views');
  await expect(page.locator('.chat-plus')).toHaveAttribute('href', '/chat/new');
  await goto('/chat?filter=starred');
  await expect(main().getByRole('heading', { name: 'Nothing starred' })).toBeVisible();
  await expect(page.locator('.chat-filter[aria-current="page"]')).toHaveText('Starred');
  await goto('/chat?filter=unread');
  await expect(main().getByRole('heading', { name: 'Nothing unread' })).toBeVisible();
  await goto('/chat?linked=true');
  await expect(main().getByRole('heading', { name: 'No conversations here yet' })).toBeVisible();
  await expect(page.locator('.chat-filter').first()).toHaveAttribute('href', '/chat?linked=true');
  console.log('PASS empty list states per view, with filter chips preserving linked');

  // A failed list read: each group says so with a way to try again; nothing else is shown in its place.
  await mode('chat-list-failed');
  await goto('/chat');
  for (const name of ['About the work', 'Team conversations']) {
   await expect(group(name).getByRole('heading', { name: 'These conversations could not be read' })).toBeVisible();
   await expect(group(name).getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/chat');
  }
  await expect(main()).not.toContainText('No conversations yet');
  await mode('');
  await goto('/chat');
  await expect(main().getByRole('heading', { name: 'No conversations yet' })).toBeVisible();
  console.log('PASS a failed list read shows a per-group error with retry, then recovers');

  // Unusable links are refused as a whole, never guessed.
  for (const query of ['filter=inbox', 'linked=yes', 'filter=all&filter=unread', 'sort=new', 'work=not%20a%20cursor!', 'linked=true&team=abc', 'linked=false&work=abc']) {
   await goto(`/chat?${query}`);
   await expect(main().getByRole('heading', { name: 'This link could not be read' }), query).toBeVisible();
   await expect(main().getByRole('link', { name: 'Show all conversations' })).toHaveAttribute('href', '/chat');
  }
  console.log('PASS repeated, unknown and malformed list settings show the link error');

  // Chat views: two groups of filter and linked pairs; sentences, never counts; the plus.
  await goto('/chat/views');
  const viewLinks = { Conversations: [['All conversations', '/chat'], ['Unread', '/chat?filter=unread'], ['Starred', '/chat?filter=starred']],
   'Linked to work': [['Linked', '/chat?linked=true'], ['Not linked', '/chat?linked=false']] };
  for (const [name, links] of Object.entries(viewLinks)) {
   const region = group(name);
   await expect(region.locator('a.view-row')).toHaveCount(links.length);
   for (const [label, href] of links) await expect(region.locator('a.view-row').filter({ hasText: label }).first()).toHaveAttribute('href', href);
   assert.doesNotMatch(await region.innerText(), /\d/, `${name} shows no counts`);
  }
  await expect(page.locator('.view-row--disabled')).toHaveCount(0);
  await expect(page.locator('.chat-plus')).toHaveAttribute('href', '/chat/new');
  console.log('PASS chat views list the five filter/linked views without counts');

  // New conversation from a task: the task is an editable, removable default, read through the Work API.
  await goto(`/chat/new?link=task:${taskId}`);
  await expect(page.getByRole('link', { name: 'Back to Confirm packaging slot' })).toHaveAttribute('href', `/work/tasks/${taskId}`);
  const chips = page.getByRole('list', { name: 'Linked tasks and projects' });
  await expect(chips.locator('li')).toHaveCount(1);
  await expect(chips).toContainText('Task: Confirm packaging slot');
  await expect(page.locator('.chat-plus')).toHaveCount(0);
  await chips.getByRole('button', { name: 'Remove Confirm packaging slot' }).click();
  await expect(page.getByText('Not linked to any task or project.')).toBeVisible();
  // Unusable suggestions: nothing is linked, and the page says so.
  await goto('/chat/new?link=task:nope');
  await expect(main()).toContainText('could not be read, so nothing is linked yet');
  await expect(page.getByText('Not linked to any task or project.')).toBeVisible();
  await goto(`/chat/new?link=project:${randomUUID()}`);
  await expect(main()).toContainText('That project could not be used');
  await expect(page.getByText('Not linked to any task or project.')).toBeVisible();
  console.log('PASS ?link= default is editable and removable; unusable suggestions link nothing');

  // Create with Pat, the default task and a project found through the Work picker's search.
  await goto(`/chat/new?link=task:${taskId}`);
  await title().fill('Packaging handover');
  await page.getByRole('checkbox', { name: 'Pat Baker' }).check();
  await expect(page.getByText('You + 1 (up to 49 others)')).toBeVisible();
  const projectField = page.locator('.field').filter({ has: page.locator('select[name="chat-link-project"]') });
  await projectField.locator('summary').filter({ hasText: 'Find more projects' }).click();
  await projectField.getByLabel('Search by name').fill('Autumn');
  await projectField.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(projectField.locator(`option[value="${fixture.projectId}"]`)).toHaveCount(1);
  await projectField.locator('select[name="chat-link-project"]').selectOption(fixture.projectId);
  await expect(chips.locator('li')).toHaveCount(2);
  await expect(chips).toContainText('Project: Autumn launch');
  let mark = await chatMark();
  await startButton().click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  const created = await api(`/conversations/${newThreadId()}`);
  assert.equal(created.title, 'Packaging handover');
  assert.deepEqual(created.participants.map(p => p.userId).sort(), [lower(fixture.userId), lower(fixture.memberUserId)].sort());
  assert.deepEqual(created.links.map(l => `${l.kind}:${l.targetId}`).sort(), [`project:${fixture.projectId}`, `task:${taskId}`].sort());
  assert.equal((await createsSince(mark)).length, 1, 'one create request');
  assert.equal(await storedRecord(createKey(fixture.orgId)), null, 'a confirmed create leaves nothing pending');
  // Pat, a participant, sees it in About the work: first as the API answers Pat (the source of truth), then on Pat's
  // list, waiting for the rendered rows rather than reading them once.
  assert.ok((await apiPage('all', true, null, fixture.memberToken)).conversations.some(c => c.id === created.id), 'the API lists it for Pat');
  await goto('/chat', patPage);
  await expect(patPage.getByRole('list', { name: 'About the work', exact: true })).toBeVisible();
  await expect.poll(() => rowIds('About the work', patPage), { message: 'Pat sees the new conversation' }).toContain(created.id);
  // Both links are written in one transaction, so which is "first" (created_at, then id) is not fixed: either, plus one.
  await expect(patPage.locator(`a.chat-row[href="/chat/${created.id}"]`).locator('.chat-row__link')).toHaveText(/^(Task: Confirm packaging slot|Project: Autumn launch)$/);
  await expect(patPage.locator(`a.chat-row[href="/chat/${created.id}"]`).locator('.chat-row__more')).toHaveText('+1');
  console.log('PASS create with a person, the default task and a searched project; Pat sees it');

  // Uncertain create: locked, restored after reload with the same id, resolved to exactly one conversation.
  await goto('/chat/new');
  await title().fill('Uncertain create');
  await mode('chat-create-uncertain');
  await startButton().click();
  await expect(main()).toContainText('Captain could not confirm whether this conversation was created');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(title()).toBeDisabled();
  const uncertain = await storedRecord(createKey(fixture.orgId));
  assert.equal(uncertain.state, 'uncertain'); assert.equal(uncertain.title, 'Uncertain create');
  assert.doesNotMatch(JSON.stringify(uncertain), /token|session|bearer/i);
  assert.equal((await titled('Uncertain create')).length, 1, 'the fixture committed it and lost only the answer');
  await mode('');
  await page.reload();
  await expect(title()).toHaveValue('Uncertain create');
  await expect(title()).toBeDisabled();
  mark = await chatMark();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expectThread(uncertain.id);
  assert.equal((await createsSince(mark)).length, 1);
  const resolved = await titled('Uncertain create');
  assert.equal(resolved.length, 1, 'same id: still exactly one conversation'); assert.equal(resolved[0].id, uncertain.id);
  assert.equal(await storedRecord(createKey(fixture.orgId)), null);
  console.log('PASS uncertain create locks, survives reload and resolves by the same id to one conversation');

  // An id already used with other details: nothing created; Start again keeps the fields with a new id.
  await goto('/chat/new');
  await plant(createKey(fixture.orgId), { v: 1, userId: lower(fixture.userId), organisationId: lower(fixture.orgId), id: created.id,
   title: 'Taken identity', participantIds: [], links: [], state: 'rate-limited', retryAt: Date.now() - 1000, code: null });
  await page.reload();
  await expect(title()).toHaveValue('Taken identity');
  await expect(startButton()).toBeEnabled(); // a rate-limited record whose wait has passed is editable and sendable
  await startButton().click();
  await expect(main()).toContainText('could not use its reserved identity');
  // Start again only gives the create a new id: it must not submit. Nothing is sent until the person presses Start
  // conversation (a reused button once turned this click into a submit).
  mark = await chatMark();
  await page.getByRole('button', { name: 'Start again', exact: true }).click();
  await expect(title()).toHaveValue('Taken identity');
  await expect(startButton()).toBeEnabled();
  await pause(1500);
  await expect(page).toHaveURL(`${origin}/chat/new`);
  assert.equal((await createsSince(mark)).length, 0, 'Start again sends nothing');
  await startButton().click();
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  assert.equal((await createsSince(mark)).length, 1, 'one create, from the explicit Start conversation');
  assert.notEqual(newThreadId(), created.id);
  assert.equal((await titled('Taken identity')).length, 1);
  assert.equal((await api(`/conversations/${created.id}`)).title, 'Packaging handover', 'the existing conversation is untouched');
  console.log('PASS a taken id refuses without creating; Start again creates once with a new id');

  // Another tab switches organisation: this tab's creates are refused before any API call, kept for their own
  // organisation, hidden in the other, and resolved when it returns.
  const second = await (await fetch(`${apiOrigin}/v1/organisations`, { method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Second bakery' }) })).json();
  assert.ok(second.id, 'second organisation for the owner');
  const secondBase = `/v1/organisations/${second.id}`;
  // A fresh create.
  await goto('/chat/new');
  await title().fill('Scope fresh');
  await useOrganisation(second.id);
  mark = await chatMark();
  await startButton().click();
  await expect(main().getByRole('alert')).toContainText('opened for a different sign-in or organisation');
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(title()).toBeDisabled();
  assert.equal((await createsSince(mark)).length, 0, 'nothing sent under either organisation');
  assert.equal((await titled('Scope fresh')).length, 0);
  assert.equal((await allConversations(secondBase)).length, 0);
  const fresh = await storedRecord(createKey(fixture.orgId));
  assert.equal(fresh.title, 'Scope fresh'); assert.equal(fresh.state, 'refused'); assert.equal(fresh.code, 'not_sent');
  // In the second organisation nothing of the first is shown or sent.
  await page.reload();
  await expect(title()).toHaveValue('');
  await expect(startButton()).toBeEnabled();
  assert.ok(await storedRecord(createKey(fixture.orgId)), 'the first organisation\'s record is kept, hidden');
  // Back in the first organisation it is restored, editable, with its id.
  await useOrganisation(fixture.orgId); await page.reload();
  await expect(title()).toHaveValue('Scope fresh');
  await expect(main()).toContainText('was not sent before your session or organisation changed');
  await startButton().click();
  await expectThread(fresh.id);
  assert.equal((await titled('Scope fresh')).length, 1);
  // An uncertain create retried after the switch.
  await goto('/chat/new');
  await title().fill('Scope uncertain');
  await mode('chat-create-uncertain'); await startButton().click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible(); await mode('');
  const scoped = await storedRecord(createKey(fixture.orgId));
  assert.equal(scoped.state, 'uncertain');
  await useOrganisation(second.id);
  mark = await chatMark();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(main().getByRole('alert')).toContainText('opened for a different sign-in or organisation');
  assert.equal((await createsSince(mark)).length, 0);
  assert.equal((await allConversations(secondBase)).length, 0);
  const kept = await storedRecord(createKey(fixture.orgId));
  assert.equal(kept.id, scoped.id); assert.equal(kept.state, 'uncertain', 'the lock and id survive the refusal');
  await useOrganisation(fixture.orgId); await page.reload();
  await expect(title()).toHaveValue('Scope uncertain');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expectThread(scoped.id);
  assert.equal((await titled('Scope uncertain')).length, 1);
  assert.equal((await allConversations(secondBase)).length, 0);
  console.log('PASS an organisation switch in another tab refuses old-scope creates, keeps them hidden and resolves them on return');

  // Expired session: nothing sent; locked with Sign in again; the create keeps its id for after signing in.
  await goto('/chat/new');
  await title().fill('After expiry');
  await context.clearCookies();
  mark = await chatMark();
  await startButton().click();
  await expect(main().getByRole('alert')).toContainText('Your session has ended, so nothing was sent');
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/sign-in?return_to=%2Fchat%2Fnew');
  await expect(title()).toBeDisabled();
  assert.equal((await createsSince(mark)).length, 0);
  const expired = await storedRecord(createKey(fixture.orgId));
  assert.equal(expired.title, 'After expiry'); assert.equal(expired.code, 'not_sent');
  await context.addCookies([{ name: 'captain_session', value: fixture.token, url: origin }]); await useOrganisation(fixture.orgId);
  await page.reload();
  await expect(title()).toHaveValue('After expiry');
  await startButton().click();
  await expectThread(expired.id);
  assert.equal((await titled('After expiry')).length, 1);
  console.log('PASS an expired session sends nothing, locks, and keeps the create for after sign-in');

  // Bulk data through the real API: Pat starts 55 linked and 55 team conversations with the owner, each with one
  // message from Pat (unread for the owner); the owner stars all of them. Two owner conversations are read and not
  // starred, so Unread and Starred must leave them out.
  const bulk = { work: [], team: [] };
  for (const [key, count] of [['work', 55], ['team', 55]]) for (let i = 1; i <= count; i++) {
   const c = await api('/conversations', 'POST', { id: randomUUID(), title: `${key === 'work' ? 'Linked' : 'Team'} bulk ${String(i).padStart(3, '0')}`,
    participantIds: [fixture.userId], links: key === 'work' ? [{ kind: 'task', targetId: taskId }] : [] }, fixture.memberToken);
   await api(`/conversations/${c.id}/messages`, 'POST', { id: randomUUID(), body: `Opening ${i}` }, fixture.memberToken);
   await api(`/conversations/${c.id}/star`, 'POST');
   bulk[key].push(c.id);
  }
  const quietLinked = await api('/conversations', 'POST', { id: randomUUID(), title: 'Quiet linked', participantIds: [], links: [{ kind: 'project', targetId: fixture.projectId }] });
  const quietTeam = await api('/conversations', 'POST', { id: randomUUID(), title: 'Quiet team', participantIds: [], links: [] });
  console.log('PASS seeded 110 conversations with unread messages and stars through the real API');

  // Each view × group: rows are exactly the API's page for that view; More pages one group and keeps the other.
  for (const filter of ['all', 'unread', 'starred']) {
   const q = filter === 'all' ? '' : `filter=${filter}`;
   const work1 = await apiPage(filter, true), team1 = await apiPage(filter, false);
   assert.equal(work1.conversations.length, 50); assert.ok(work1.nextCursor, `${filter}: more than 50 linked`);
   assert.equal(team1.conversations.length, 50); assert.ok(team1.nextCursor, `${filter}: more than 50 team`);
   await goto(`/chat${q ? `?${q}` : ''}`);
   await expect(page.locator('.chat-filter[aria-current="page"]')).toHaveText({ all: 'All', unread: 'Unread', starred: 'Starred' }[filter]);
   await expect.poll(() => rowIds('About the work'), { message: `${filter} work page 1` }).toEqual(work1.conversations.map(c => c.id));
   await expect.poll(() => rowIds('Team conversations'), { message: `${filter} team page 1` }).toEqual(team1.conversations.map(c => c.id));
   // `linked` omitted means both groups: linked conversations in About the work, unlinked in Team, and every one of
   // the API's newest 50 for this filter with linked omitted appears in one of the two first pages.
   assert.equal(new URL(page.url()).searchParams.has('linked'), false);
   assert.ok(work1.conversations.every(c => c.linkSummary.count > 0), `${filter}: About the work holds linked conversations only`);
   assert.ok(team1.conversations.every(c => c.linkSummary.count === 0), `${filter}: Team holds unlinked conversations only`);
   const either = await api(`/conversations?${new URLSearchParams({ filter, limit: '50' })}`);
   const firstPages = new Set([...work1.conversations, ...team1.conversations].map(c => c.id));
   assert.ok(either.conversations.every(c => firstPages.has(c.id)), `${filter}: the linked-omitted view is split between the two groups`);
   if (filter !== 'all') {
    const shown = [...await rowIds('About the work'), ...await rowIds('Team conversations')];
    assert.ok(!shown.includes(quietLinked.id) && !shown.includes(quietTeam.id), `${filter} leaves out read, unstarred conversations`);
   }
   // More in About the work: work page 2, Team still on page 1.
   await group('About the work').getByRole('link', { name: 'More', exact: true }).click();
   await page.waitForURL(/[?&]work=/);
   let url = new URL(page.url());
   assert.equal(url.searchParams.get('team'), null); assert.equal(url.searchParams.get('filter'), filter === 'all' ? null : filter);
   const work2 = await apiPage(filter, true, work1.nextCursor);
   await expect.poll(() => rowIds('About the work'), { message: `${filter} work page 2` }).toEqual(work2.conversations.map(c => c.id));
   assert.deepEqual(await rowIds('Team conversations'), team1.conversations.map(c => c.id), `${filter} team kept on page 1`);
   // More in Team: both cursors now in the URL; work stays on page 2.
   await group('Team conversations').getByRole('link', { name: 'More', exact: true }).click();
   await page.waitForURL(/[?&]team=/);
   url = new URL(page.url());
   assert.equal(url.searchParams.get('work'), work1.nextCursor, 'work cursor kept');
   const team2 = await apiPage(filter, false, team1.nextCursor);
   await expect.poll(() => rowIds('Team conversations'), { message: `${filter} team page 2` }).toEqual(team2.conversations.map(c => c.id));
   assert.deepEqual(await rowIds('About the work'), work2.conversations.map(c => c.id), `${filter} work kept on page 2`);
   // Newest returns one group to its first page and keeps the other's place.
   await group('About the work').getByRole('link', { name: 'Newest', exact: true }).click();
   await page.waitForURL(url => !url.searchParams.has('work'));
   assert.equal(new URL(page.url()).searchParams.get('team'), team1.nextCursor);
   await expect.poll(() => rowIds('About the work')).toEqual(work1.conversations.map(c => c.id));
   assert.deepEqual(await rowIds('Team conversations'), team2.conversations.map(c => c.id), 'team keeps its place');
   // Changing the filter drops both cursors.
   const nextFilter = filter === 'starred' ? 'All' : 'Starred';
   await page.locator('.chat-filter').filter({ hasText: nextFilter }).click();
   await page.waitForURL(url => !url.searchParams.has('work') && !url.searchParams.has('team'));
  }
  // Unread markers are per conversation; nothing sums them.
  await goto('/chat?filter=unread');
  await expect(page.locator('a.chat-row .chat-row__unread').first()).toHaveText('1');
  assert.doesNotMatch(await page.locator('.tabbar').first().innerText().catch(() => ''), /\d/, 'no badge on the tab bar');
  await expect(chipNav()).toBeVisible();
  assert.doesNotMatch(await chipNav().innerText(), /\d/, 'no counts on the filter chips');
  console.log('PASS All/Unread/Starred × About the work/Team page independently and match the API');

  // A linked view shows only its group and pages with its own cursor.
  for (const [linked, name, other, key] of [[true, 'About the work', 'Team conversations', 'work'], [false, 'Team conversations', 'About the work', 'team']]) {
   const first = await apiPage('unread', linked);
   await goto(`/chat?filter=unread&linked=${linked}`);
   // Wait for the real page (not the loading screen, which has no groups) before asserting a group is absent.
   await expect(group(name)).toBeVisible();
   await expect(group(other)).toHaveCount(0);
   await expect.poll(() => rowIds(name)).toEqual(first.conversations.map(c => c.id));
   await group(name).getByRole('link', { name: 'More', exact: true }).click();
   await page.waitForURL(new RegExp(`[?&]${key}=`));
   const nextIds = (await apiPage('unread', linked, first.nextCursor)).conversations.map(c => c.id);
   await expect.poll(() => rowIds(name)).toEqual(nextIds);
  }
  console.log('PASS Linked and Not linked views show one group each and page on their own cursor');

  // Cursors the API refuses: that group shows its error with the API's words; the other group still renders.
  const unreadWork = (await apiPage('unread', true)).nextCursor;
  await goto(`/chat?filter=starred&work=${encodeURIComponent(unreadWork)}`);
  await expect(group('About the work').getByRole('heading', { name: 'These conversations could not be read' })).toBeVisible();
  // The API's own words (apps/api/src/chat/service.ts decodeCursor), passed through unchanged.
  await expect(group('About the work')).toContainText('That page cursor belongs to a different view. Start the view again from its first page.');
  await expect.poll(async () => (await rowIds('Team conversations')).length).toBe(50);
  await goto('/chat?team=AAAA');
  await expect(group('Team conversations').getByRole('heading', { name: 'These conversations could not be read' })).toBeVisible();
  await expect(group('Team conversations')).toContainText('That page cursor cannot be read.');
  await expect.poll(async () => (await rowIds('About the work')).length).toBe(50);
  console.log('PASS a cursor from another view or an unreadable cursor fails only its group');

  // Layouts: list, a linked view, views and new, at four widths. Chips and the plus stay reachable; nothing overflows.
  // Each page is measured only once its own content is visible: while it streams in under chat/loading.tsx the
  // incoming page is hidden (zero-sized), so measuring earlier reads the loading screen or 0px chips.
  const shown = {
   list: () => expect(chipNav()).toBeVisible(),
   'unread-team': () => expect(group('Team conversations')).toBeVisible(),
   views: () => expect(group('Linked to work')).toBeVisible(),
   new: () => expect(title()).toBeVisible()
  };
  for (const [name, route] of [['list', '/chat'], ['unread-team', '/chat?filter=unread&linked=false'], ['views', '/chat/views'], ['new', `/chat/new?link=task:${taskId}`]]) {
   for (const width of [360, 390, 430, 1440]) {
    await page.setViewportSize({ width, height: 874 });
    await goto(route);
    await shown[name]();
    await noOverflow();
    if (name === 'list' || name === 'unread-team') {
     const chipLinks = chipNav().getByRole('link');
     await expect(chipLinks).toHaveCount(3);
     for (const height of await chipLinks.evaluateAll(chips => chips.map(c => c.getBoundingClientRect().height))) assert.ok(height >= 44, `filter chip ${height}px at ${width}`);
     await expect(page.getByRole('link', { name: 'Back to Views' })).toBeVisible();
    }
    if (name === 'new') await expect(page.locator('.chat-plus')).toHaveCount(0);
    else await expect(page.locator('.chat-plus')).toBeVisible();
    await screenshot({ path: path.join(directory, `chat-${name}-${width}.png`), fullPage: true });
   }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  console.log('PASS 360/390/430/1440 layouts for list, views and new');

  assert.deepEqual(errors, [], 'no page or console errors');
 } catch (error) { await screenshot({ path: path.join(directory, 'chat-views-failure.png'), fullPage: true }).catch(() => {}); console.error('PAGE', page.url(), await main().innerText().catch(() => '')); console.error('PAT PAGE', patPage.url(), await main(patPage).innerText().catch(() => '')); if (errors.length) console.error('ERRORS', errors); throw error; }
 finally { await mode('').catch(() => {}); await patContext.close().catch(() => {}); await context.close(); await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
