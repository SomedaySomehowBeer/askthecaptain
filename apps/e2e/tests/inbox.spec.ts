import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';
const token = process.env.E2E_SESSION_TOKEN?.trim();
test.describe('retired mailbox', () => {
 test.skip(!token, 'E2E_SESSION_TOKEN is not set; signed-in checks need a session');
 test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });
 for (const route of ['/inbox', '/inbox/00000000-0000-4000-8000-000000000000']) test(`${route} cannot draft or send mail`, async ({ page }) => {
  await page.goto(webUrl() + route);
  await expect(page.getByRole('heading', { name: 'This part of Captain has been retired' })).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Send|Draft|Sync/ })).toHaveCount(0);
 });
});
