import { test as base, expect } from '@playwright/test';
import { webUrl } from '../targets.ts';
// Optional CDP connection lets the same check use the shared droplet browser.
const test = base.extend({ browser: async ({ playwright }, use) => {
 const browser = process.env.E2E_CDP_URL ? await playwright.chromium.connectOverCDP(process.env.E2E_CDP_URL) : await playwright.chromium.launch();
 try { await use(browser); } finally { await browser.close(); }
} });
const token = process.env.E2E_SESSION_TOKEN?.trim();
test('Settings links to inference with real allowance and usage states', async ({ context, page }) => {
 test.skip(!token, 'E2E_SESSION_TOKEN is required for the signed-in inference check');
 await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]);
 await page.goto(`${webUrl()}/settings`); await page.getByRole('link', { name: 'Manage inference' }).click();
 await expect(page.getByRole('heading', { name: 'Inference', exact: true })).toBeVisible();
 await expect(page.getByRole('heading', { name: 'Monthly token allowance' })).toBeVisible();
 await expect(page.getByRole('heading', { name: 'This month’s usage' })).toBeVisible();
 await expect(page.locator('.notice--failed')).toHaveCount(0);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
