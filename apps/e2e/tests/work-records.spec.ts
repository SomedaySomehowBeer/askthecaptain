import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';
const token = process.env.E2E_SESSION_TOKEN?.trim();
test.describe('Work records and inventory', () => {
 test.skip(!token, 'E2E_SESSION_TOKEN is not set; signed-in checks need a session');
 test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });
 test('create a standalone task, complete and reopen it', async ({page}) => {
  await page.goto(`${webUrl()}/work/new`);const title=`Shared work ${Date.now()}`;
  await page.getByLabel('Task',{exact:true}).fill(title);await page.getByRole('button',{name:'Add task',exact:true}).click();
  await expect(page).toHaveURL(/\/work\/tasks\/[0-9a-f-]+$/);await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Mark task complete',exact:true}).click();
  await expect(page.locator('dd').filter({hasText:/^done$/})).toBeVisible();
  await page.getByRole('button',{name:'Reopen task',exact:true}).click();
  await expect(page.locator('dd').filter({hasText:/^open$/})).toBeVisible();
 });
 test('create standalone recurring work and see its occurrence',async ({page})=>{
  await page.goto(`${webUrl()}/work/series/new`);const title=`Inspection ${Date.now()}`;
  await page.getByLabel('Recurring task',{exact:true}).fill(title);await page.getByLabel('First period starts').fill('2020-01-01');
  await page.getByRole('button',{name:'Create recurring work',exact:true}).click();await expect(page).toHaveURL(/\/work\/series\/[0-9a-f-]+$/);
  await expect(page.locator('.work-task').filter({hasText:title})).toBeVisible();
 });
	test('stock is counted by location, warns below reorder point, and archives without losing its count', async ({ page }) => {
		await page.goto(`${webUrl()}/resources/inventory`);
		const stock = page.getByRole('region', { name: 'Stock', exact: true });
		await expect(stock).toBeVisible();
		await stock.locator('summary', { hasText: 'Add a stock item' }).click();
		const form = stock.locator('form').filter({ has: page.locator('#stock-new-name') });
		const name = `Malt bags ${Date.now()}`;
		await form.getByLabel('Item name', { exact: true }).fill(name);
		await form.getByLabel('Location', { exact: true }).fill('Store room');
		await form.getByLabel('Unit label', { exact: true }).fill('bags');
		await form.getByLabel('Reorder point (optional)', { exact: true }).fill('5');
		await form.getByRole('button', { name: 'Add stock item', exact: true }).click();
		const item = stock.getByRole('article', { name, exact: true });
		await expect(item).toContainText('Not counted yet.');
		await item.getByLabel(`Count for ${name}`, { exact: true }).fill('2.5');
		await item.getByRole('button', { name: 'Save count', exact: true }).click();
		await expect(item).toContainText('2.5 bags');
		await expect(item).toContainText('Counted');
		await expect(item).toContainText('Below reorder point.');
		await item.getByRole('button', { name: 'Archive item', exact: true }).click();
		await expect(item).toBeHidden();
		await stock.locator('summary', { hasText: 'Archived stock' }).click();
		await expect(item).toContainText('2.5 bags');
		await expect(item.getByRole('button', { name: 'Save count', exact: true })).toBeDisabled();
	});

});
