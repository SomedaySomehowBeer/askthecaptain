/** Members/invitations on the production cookie client, with synthetic API replies and clipboard adapter.
 * No actual email, workspace or clipboard is changed. */
const { expect } = require('@playwright/test');
const path = require('node:path');
module.exports = async ({ browser, production, base, shots, width }) => {
 const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 500 });
 try {
  const page = await context.newPage(); page.setDefaultTimeout(15000); await page.clock.install();
  const userId = '00000000-0000-4000-8000-000000000001', staffId = '00000000-0000-4000-8000-000000000002', secondOwner = '00000000-0000-4000-8000-000000000008';
  const a = '00000000-0000-4000-8000-000000000003', b = '00000000-0000-4000-8000-000000000004', inviteId = '00000000-0000-4000-8000-000000000005';
  const user = { id: userId, email: 'owner@example.test', name: 'Sam Skipper' };
  const row = (userId, role, name, email) => ({ userId, role, name, email, status: 'active', since: '2026-09-01T00:00:00.000Z' });
  let memberships, records, invitations, listMode, writeMode, releaseList, releaseWrite;
  const reset = () => {
   memberships = [{ organisationId: a, organisationName: 'Harbour Brewing', role: 'owner', status: 'active' }, { organisationId: b, organisationName: 'Quayside Cellars', role: 'owner', status: 'active' }];
   records = { [a]: [row(userId, 'owner', user.name, user.email), row(staffId, 'member', 'Pat Crew', 'pat@example.test')], [b]: [row(userId, 'owner', user.name, user.email)] };
   invitations = { [a]: [], [b]: [] }; listMode = 'ok'; writeMode = 'ok';
  }; reset();
  const requests = [], errors = [], outside = [];
  page.on('pageerror', error => errors.push(error.message));
  const id = name => page.getByTestId(name).filter({ visible: true });
  const go = route => page.goto(new URL(route, production).href);
  const noOverflow = async () => expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth), `${width}px Members`).toBeLessThanOrEqual(1);
  const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-members-${name}.png`), fullPage: true }); };
  await context.route('**/*', async route => {
   const req = route.request(), url = new URL(req.url());
   if (![production.origin, base.origin].includes(url.origin)) { outside.push(url.origin); return route.abort(); }
   const json = (status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
   if (url.pathname.startsWith('/v1/')) {
    requests.push({ method: req.method(), path: url.pathname });
    expect(req.headers()['x-captain-client']).toBe('web'); expect(req.headers().authorization).toBeUndefined();
    if (url.pathname === '/v1/me') return json(200, { user, memberships, passkeyVerified: true });
    if (url.pathname === '/v1/me/passkeys') return json(200, { available: false, passkeys: [] });
    const match = /^\/v1\/organisations\/([^/]+)\/(members|invitations)(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) return json(503, {});
    const [, org, collection, target] = match;
    if (req.method() === 'GET') {
     if (listMode === 'fail') return json(503, {});
     if (listMode === 'refused') return json(403, { code: 'forbidden' });
     if (listMode === 'hold') return new Promise(resolve => { releaseList = async () => { listMode = 'ok'; await json(200, { members: records[org] }); resolve(); }; });
     return json(200, collection === 'members' ? { members: records[org] } : { invitations: invitations[org] });
    }
    if (writeMode === 'last_owner') return json(400, { code: 'last_owner' });
    if (writeMode === 'membership_changed') return json(409, { code: 'membership_changed' });
    if (writeMode === 'already_member') return json(400, { code: 'already_member' });
    if (writeMode === '401') return json(401, { code: 'unauthorised' });
    if (writeMode === 'forbidden') return json(403, { code: 'forbidden' });
    if (collection === 'invitations' && req.method() === 'POST') {
     const input = req.postDataJSON();
     const invitation = { id: inviteId, email: input.email.toLowerCase(), role: input.role, invitedBy: userId, expiresAt: '2030-10-07T00:00:00.000Z', acceptedAt: null, revokedAt: null, createdAt: '2026-09-30T00:00:00.000Z' };
     invitations[org] = [invitation];
     const answer = () => json(201, { invitation, token: 'inv_' + (org === a ? 'a' : 'b').repeat(43) });
     if (writeMode === 'hold') return new Promise(resolve => { releaseWrite = async () => { await answer(); resolve(); }; });
     if (writeMode === 'unknown') return json(503, {}, { 'retry-after': '5' });
     return answer();
    }
    if (collection === 'members' && req.method() === 'PATCH') {
     records[org] = records[org].map(row => row.userId === target ? { ...row, role: req.postDataJSON().role } : row);
     if (target === userId) memberships = memberships.map(row => row.organisationId === org ? { ...row, role: req.postDataJSON().role } : row);
    } else if (collection === 'members') records[org] = records[org].filter(row => row.userId !== target);
    else invitations[org] = invitations[org].filter(row => row.id !== target);
    return json(200, { ok: true });
   }
   const upstream = new URL(url); if (upstream.hostname === 'localhost') upstream.hostname = '127.0.0.1';
   return route.fulfill({ response: await route.fetch({ url: upstream.href, maxRedirects: 0 }) });
  });
  // Entry from Settings and deliberate list loading, with no fabricated empty list.
  await go('/settings'); await id('account-members').click(); await expect(id(`member-${staffId}`)).toBeVisible();
  await expect(id(`member-remove-${userId}`)).toBeDisabled(); await noOverflow(); await shot('owner');
  await id('invite-email').fill('new@example.test'); await page.getByRole('group', { name: 'Invitation role', exact: true }).getByRole('button', { name: 'admin', exact: true }).click();
  await id('invite-create').click(); await expect(id('members-status')).toContainText('No email was sent');
  await expect(id('invitation-link')).toHaveValue(new URL('/invitations/accept?token=inv_' + 'a'.repeat(43), production).href);
  // Clipboard is synthetic and explicit; a refusal retains a selectable link.
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText(value) { window.__copiedInvitation = value; } } }); });
  await id('invitation-copy').click(); await expect(id('invitation-copy-status')).toHaveText('Link copied.'); expect(await page.evaluate(() => window.__copiedInvitation)).toContain('inv_' + 'a'.repeat(43));
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('blocked'); }; });
  await id('invitation-copy').click(); await expect(id('invitation-copy-status')).toContainText('Select and copy'); await noOverflow(); await shot('invitation');
  await id(`invitation-revoke-${inviteId}`).click(); await expect(id('invitations-empty')).toBeVisible(); await expect(id('invitation-link')).toHaveCount(0);
  await id(`member-${staffId}`).getByRole('button', { name: 'admin', exact: true }).click(); await id(`member-role-${staffId}`).click(); await expect(id(`member-${staffId}`)).toContainText('Role: admin');
  writeMode = 'membership_changed'; await id(`member-remove-${staffId}`).click(); await expect(id('members-status')).toContainText('changed while'); await expect(id('invite-create')).toBeDisabled(); writeMode = 'ok'; await id('members-refresh').click();
  await id(`member-remove-${staffId}`).click(); await expect(id(`member-${staffId}`)).toHaveCount(0);
  writeMode = 'already_member'; await id('invite-create').click(); await expect(id('members-status')).toContainText('already a member'); writeMode = 'ok'; await id('members-refresh').click();
  writeMode = 'unknown'; await id('invite-create').click(); await expect(id('members-status')).toContainText("Couldn't confirm whether"); await expect(id('invitation-link')).toHaveCount(0); await expect(id('members-refresh')).toBeDisabled();
  await page.clock.fastForward(5100); await expect(id('members-refresh')).toBeEnabled(); await expect(id('invite-create')).toBeDisabled(); writeMode = 'ok'; await id('members-refresh').click(); await expect(id(`invitation-${inviteId}`)).toBeVisible(); await expect(id('invitation-link')).toHaveCount(0);
  listMode = 'fail'; await id('members-refresh').click(); await expect(id('members-status')).toContainText("Couldn't load"); await expect(id('invite-create')).toHaveCount(0); await shot('failed'); listMode = 'ok'; await id('members-refresh').click(); await expect(id('invite-create')).toBeEnabled();
  listMode = 'hold'; await id('members-refresh').click(); await expect(id('members-loading')).toBeVisible(); await expect(id('invitations-empty')).toHaveCount(0); await expect.poll(() => Boolean(releaseList)).toBe(true); await releaseList(); await expect(id('invite-create')).toBeEnabled();
  // Leave while an invitation write is pending, switch tenant, then release the old reply.
  writeMode = 'hold'; await id('invite-create').click(); await expect(id('members-saving')).toBeVisible(); await expect(id('invite-create')).toBeDisabled(); await expect.poll(() => Boolean(releaseWrite)).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await id('account-action-switch').click(); await page.getByRole('button', { name: /Quayside Cellars/ }).click();
  await page.getByRole('button', { name: 'Account and settings', exact: true }).click(); await id('account-members').click(); await expect(page.getByText('Quayside Cellars', { exact: true }).last()).toBeVisible(); await releaseWrite(); writeMode = 'ok'; await expect(id('invitation-link')).toHaveCount(0); await expect(id('invitations-empty')).toBeVisible();
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })); expect(JSON.stringify(storage)).not.toContain('inv_');
  // Admin controls cannot touch owners; ordinary members cannot read this management screen.
  reset(); memberships[0].role = 'admin'; records[a][0].role = 'admin'; records[a].push(row(secondOwner, 'owner', 'Owner Two', 'two@example.test'));
  await page.evaluate(() => localStorage.clear()); await go('/members'); await expect(id(`member-${secondOwner}`)).toContainText('Only an owner'); await expect(id(`member-remove-${secondOwner}`)).toHaveCount(0); await expect(id(`member-${staffId}`).getByRole('button', { name: 'owner', exact: true })).toHaveCount(0);
  reset(); records[a].push(row(secondOwner, 'owner', 'Owner Two', 'two@example.test')); await go('/members');
  await id(`member-${userId}`).getByRole('button', { name: 'member', exact: true }).click(); await id(`member-role-${userId}`).click(); await expect(id('members-denied')).toBeVisible(); await expect(id('invite-create')).toHaveCount(0);
  reset(); await go('/members'); writeMode = '401'; await id(`member-remove-${staffId}`).click(); await expect(id('web-sign-in')).toBeVisible();
  for (const [scenario, target] of [['members-owner', 'invite-create'], ['members-admin', 'invite-create'], ['members-empty', 'members-empty'], ['members-failed', 'members-status'], ['members-refused', 'members-status'], ['members-denied', 'members-denied']]) {
   await page.goto(new URL(`/members?scenario=${scenario}`, base).href); await expect(id(target)).toBeVisible(); await noOverflow();
  }
  await page.goto(new URL('/members?scenario=members-none', base).href); await expect(page.getByText('Choose an organisation to manage its members.')).toBeVisible();
  await page.goto(new URL('/members?scenario=ready', base).href); await expect(page.getByText('Member management is available in the browser in this version.')).toBeVisible();
  expect(errors).toEqual([]); expect(outside).toEqual([]);
  console.log(`PASS ${width}px: members, invitation link/copy/revoke, roles/removal, owner/admin restrictions, pending and uncertain writes, scope changes, session expiry and harness states`);
 } finally { await context.close(); }
};
