import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';
const token = process.env.E2E_SESSION_TOKEN?.trim();
test.describe('retired assistant destinations', () => {
 test.skip(!token, 'E2E_SESSION_TOKEN is not set; signed-in checks need a session');
 test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });
 for (const route of ['/today', '/calendar', '/notes', '/notes/00000000-0000-4000-8000-000000000000']) test(`${route} explains retirement without source controls`, async ({ page }) => {
  await page.goto(webUrl() + route);
  await expect(page.getByRole('heading', { name: 'This part of Captain has been retired' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to Work' })).toHaveAttribute('href', '/work');
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.locator('.notice--failed')).toHaveCount(0);
 });
});
