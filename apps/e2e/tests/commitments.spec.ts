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
		await page.goto(`${webUrl()}/commitments`);
		await expect(page.getByRole('heading', { name: 'Commitments', level: 1 })).toBeVisible();
		await expect(page.locator('.notice--failed')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Obligations' })).toBeVisible();
		const title = `Send price list ${Date.now()}`;
		const form = page.locator('form').filter({ has: page.getByLabel('Task') }).first();
		await form.getByLabel('Task').fill(title);
		await form.getByLabel('Due').fill('2099-12-31');
		await form.getByRole('button', { name: 'Add task' }).click();
		const line = page.locator('.task').filter({ hasText: title });
		await expect(line).toBeVisible();
		await expect(line).toContainText('due');
		await line.getByRole('button', { name: `Mark "${title}" done` }).click();
		await expect(page.locator('.task--done').filter({ hasText: title })).toBeAttached();
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
		const now = new Date();
		await expect(page.locator('.task').filter({ hasText: `${duty} — ${months[now.getMonth()]} ${now.getFullYear()}` })).toBeVisible();
	});
});
