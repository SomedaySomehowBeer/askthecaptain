import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';

// Sending is exercised ONLY against a disposable database and fake Gmail, never a tenant's mailbox.
const token = process.env.E2E_SESSION_TOKEN?.trim();
const thread = process.env.E2E_TRIAGE_THREAD;
test.describe('inbox triage fixture', () => {
 test.skip(!token || !thread || process.env.E2E_TRIAGE_FIXTURE !== '1', 'Requires a disposable triage fixture with fake Gmail');
 test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });
 test('a person edits and sends the draft from its thread', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'Mutating fixture runs once; phone rendering is checked separately.');
  await page.goto(`${webUrl()}/inbox`);
  await expect(page.getByRole('heading', { name: 'Outbox', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for a reply you drafted', exact: true })).toBeVisible();
  await page.goto(`${webUrl()}/inbox/${thread}`);
  await page.getByLabel('Reply draft').fill('A person reviewed this reply.');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await page.reload(); await expect(page.getByLabel('Reply draft')).toHaveValue('A person reviewed this reply.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Sent by a person.', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('Sent by a person.', { exact: true })).toBeVisible();
 });
});
