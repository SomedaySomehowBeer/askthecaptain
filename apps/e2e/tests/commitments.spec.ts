import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';

/** The Commitments tab as a signed-in person. Needs a session token for the deployment under test
 *  in E2E_SESSION_TOKEN (issued straight into the database; there is no API for it). Without one
 *  the check is skipped, and the skip is visible in the report rather than passing quietly. */
const token = process.env.E2E_SESSION_TOKEN?.trim();
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

test.describe('commitments', () => {
	test.skip(!token, 'E2E_SESSION_TOKEN is not set; signed-in checks need a session');
	test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });

	test('a task is added, shown with its date, and marked done', async ({ page }) => {
		let documents = 0;
		page.on('request', (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
		await page.goto(`${webUrl()}/commitments`);
		await expect(page.getByRole('heading', { name: 'Commitments', level: 1 })).toBeVisible();
		await expect(page.locator('.notice--failed')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Obligations' })).toBeVisible();
		const initialDocuments = documents;
		const title = `Send price list ${Date.now()}`;
		// Exact label match: the Done buttons' aria-labels also contain the word "task".
		const form = page.locator('form').filter({ has: page.getByLabel('Task', { exact: true }) }).first();
		await form.getByLabel('Task', { exact: true }).fill(title);
		await form.getByLabel('Due').fill('2099-12-31');
		await form.getByRole('button', { name: 'Add task' }).click();
		const line = page.locator('.task').filter({ hasText: title });
		await expect(line).toBeVisible();
		await expect(line).toContainText('due');
		await expect(form.getByLabel('Task', { exact: true })).toHaveValue('');
		await line.getByRole('button', { name: `Mark "${title}" done` }).click();
		await expect(page.locator('.task--done').filter({ hasText: title })).toBeAttached();
		expect(documents).toBe(initialDocuments);
	});

	test('a recurring duty in the deadline book produces this period\'s task', async ({ page }) => {
		await page.goto(`${webUrl()}/commitments`);
		const duty = `Excise return ${Date.now()}`;
		const book = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Obligations' }) });
		await book.locator('summary', { hasText: 'Add a recurring duty' }).click();
		const form = book.locator('form').filter({ has: page.getByLabel('Duty') });
		await form.getByLabel('Duty').fill(duty);
		await form.getByLabel('First period starts').fill('2020-01-01');
		await form.getByLabel('Due, days after the period ends').fill('21');
		await form.getByRole('button', { name: 'Add recurring duty' }).click();
		await expect(book.locator('.line').filter({ hasText: duty })).toContainText('monthly');
		// The period label is this month in the organisation's timezone, which the runner's clock need
		// not share at a month boundary: check the occurrence exists and is labelled with a month.
		const occurrence = page.locator('.task').filter({ hasText: `${duty} — ` });
		await expect(occurrence).toBeVisible();
		await expect(occurrence).toContainText(new RegExp(`— (${months.join('|')}) \\d{4}`));
		await expect(occurrence).toContainText('recurring');
	});
	test('stock is counted by location, warns below reorder point, and archives without losing its count', async ({ page }) => {
		await page.goto(`${webUrl()}/commitments`);
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
