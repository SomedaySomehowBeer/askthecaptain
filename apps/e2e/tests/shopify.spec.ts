import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';

// Explicit opt-in: a fixture shop is connected and synced, with a variant in E2E_SHOPIFY_ITEM.
// This check edits only the Captain reorder point. Never run it against production shop settings.
const token = process.env.E2E_SESSION_TOKEN?.trim();
const itemName = process.env.E2E_SHOPIFY_ITEM;
test.describe('Shopify stock', () => {
 test.skip(!token || !itemName, 'Needs a signed-in fixture session and E2E_SHOPIFY_ITEM');
 test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });
 test('shop quantity stays read-only when a member changes its reorder point', async ({ page }) => {
  await page.goto(`${webUrl()}/commitments`);
  const stock = page.locator('#shopify-stock'); const item = stock.getByRole('article', { name: itemName!, exact: true });
  await expect(item).toBeVisible(); await expect(item).toContainText('from Shopify');
  const quantity = await item.locator('p').filter({ hasText: /^-?\d+ available$/ }).innerText();
  await expect(item.getByRole('button', { name: 'Save count' })).toHaveCount(0);
  await item.locator('summary', { hasText: 'Set reorder point' }).click();
  await item.getByLabel('Reorder point for this variant').fill('999');
  await item.getByRole('button', { name: 'Save reorder point' }).click();
  await expect(item).toContainText('Reorder point: 999'); await expect(item).toContainText(quantity); await expect(item).toContainText('Below reorder point.');
  await item.locator('summary', { hasText: 'Set reorder point' }).click();
  await item.getByLabel('Reorder point for this variant').fill(''); await item.getByRole('button', { name: 'Save reorder point' }).click();
  await expect(item).not.toContainText('Reorder point: 999'); await expect(item).toContainText(quantity);
 });
 test('connection card gives members a clear disabled state', async ({ page }) => {
  await page.goto(`${webUrl()}/settings/connections`);
  const card = page.getByRole('region', { name: 'Shopify', exact: true });
  await expect(card).toContainText('Connected to'); await expect(card).toContainText('Last completed sync:');
  await expect(card).toContainText('Only an owner or admin');
  for (const name of ['Reconnect Shopify', 'Sync now', 'Disconnect Shopify']) await expect(card.getByRole('button', { name, exact: true })).toBeDisabled();
 });
});
