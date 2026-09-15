import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';
// A throwaway fixture with stocktake enabled, push/Google/inference configured, and no supplier email.
const owner = process.env.E2E_STOCKTAKE_OWNER;
const member = process.env.E2E_SESSION_TOKEN;
const location = process.env.E2E_STOCKTAKE_LOCATION;
const itemName = process.env.E2E_STOCKTAKE_ITEM;
test.describe('stocktake', () => {
 test.skip(!owner || !member || !location || !itemName, 'Needs configured stocktake fixture sessions, location and item');
 test('an owner starts a location stocktake, a member counts, and Activity shows the completed run', async ({ page, context }) => {
  await context.addCookies([{ name: 'captain_session', value: owner!, url: webUrl() }]);
  await page.goto(`${webUrl()}/settings/workflows`); const workflow = page.getByRole('region', { name: 'Stocktake', exact: true });
  const save = async (name: string) => { await Promise.all([page.waitForEvent('load'), workflow.getByRole('button', { name, exact: true }).click()]); };
  await expect(workflow.locator('form').first()).toBeVisible();
  if (await workflow.getByRole('button', { name: 'Turn off', exact: true }).count()) { await save('Turn off'); await expect(workflow.getByRole('button', { name: 'Turn on', exact: true })).toBeVisible(); }
  await workflow.getByLabel('The location to count.', { exact: true }).fill(location!); await save('Turn on');
  await expect(workflow.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
  await save('Save parameters'); await expect(workflow.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
  await expect(workflow.getByLabel('The location to count.', { exact: true })).toHaveValue(location!);
  await page.goto(`${webUrl()}/commitments#stock`);
  const stock = page.getByRole('region', { name: 'Stock', exact: true }); await stock.getByLabel('Location to count').fill(location!);
  await stock.getByRole('button', { name: 'Start a stocktake', exact: true }).click(); await expect(page).toHaveURL(/settings\/workflows\?run=/);
  const runUrl = page.url(); const detail = page.getByRole('region', { name: /stocktake · version/ });
  await expect(async () => { await page.reload(); await expect(detail).toContainText('stock.counted'); await expect(detail).toContainText('waiting'); }).toPass({ timeout: 15000 });
  await context.addCookies([{ name: 'captain_session', value: member!, url: webUrl() }]); await page.goto(`${webUrl()}/commitments#stock`);
  await expect(stock.getByRole('button', { name: 'Start a stocktake', exact: true })).toBeDisabled();
  const item = stock.getByRole('article', { name: itemName!, exact: true }); await item.getByLabel(`Count for ${itemName}`).fill('2'); await Promise.all([page.waitForEvent('load'), item.getByRole('button', { name: 'Save count', exact: true }).click()]); await expect(item).toContainText('2 bags');
  await page.goto(runUrl); await expect(async () => { await page.reload(); await expect(detail).toContainText('stock.recordCount'); await expect(detail).toContainText('Shopify is not connected'); await expect(detail).not.toContainText('waiting'); }).toPass({ timeout: 15000 });
  await expect(detail).toContainText('No unambiguous supplier email');
  await page.goto(`${webUrl()}/commitments`); await expect(page.locator('.task').filter({ hasText: `Reorder ${itemName} (2 bags left, reorder at 5)` }).first()).toBeVisible();
 });
});
