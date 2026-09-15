import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';

/** The Today tab as a signed-in person. Needs E2E_SESSION_TOKEN; skipped, visibly, without one. */
const token = process.env.E2E_SESSION_TOKEN?.trim();

test.describe('today', () => {
	test.skip(!token, 'E2E_SESSION_TOKEN is not set; signed-in checks need a session');
	test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });

	test('the front page says what needs you and is honest about each source', async ({ page }) => {
		await page.goto(`${webUrl()}/`);
		await expect(page.getByRole('heading', { level: 1 })).toContainText(/^(Morning|Afternoon|Evening), /);
		await expect(page.locator('.notice--failed')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Waiting on you' })).toBeVisible();
		const needs = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Waiting on you' }) });
		await expect(needs.locator('.task').or(needs.getByText(/Nothing is overdue, due today or suggested/))).toBeVisible();
		const calendar = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Today', exact: true }) });
		await expect(calendar.getByText(/No calendar is connected|needs attention|not been synced|No events today|all day|–/)).toBeVisible();
		const mail = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Mail', exact: true }) });
		await expect(mail.getByText(/No mailbox is connected|needs attention|not been synced|Nothing new today|arrived today/)).toBeVisible();
		await expect(page.getByRole('heading', { name: 'The brief' })).toBeVisible();
		const brief = page.locator('section[aria-labelledby="brief"]');
		await expect(page.locator('main section').first()).toHaveAttribute('aria-labelledby', 'brief');
		await expect(brief.locator('time').or(brief.getByText('No morning brief has been produced yet.', { exact: false }))).toBeVisible();
	});
});
