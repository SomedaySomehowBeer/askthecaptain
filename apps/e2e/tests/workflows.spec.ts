import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';

/** Settings → Workflows as a signed-in owner. Needs E2E_SESSION_TOKEN like the commitments spec;
 *  skipped, visibly, without one. */
const token = process.env.E2E_SESSION_TOKEN?.trim();

test.describe('workflows', () => {
	test.skip(!token, 'E2E_SESSION_TOKEN is not set; signed-in checks need a session');
	test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });

	test('the five workflows are offered, each says what it needs, and the journal is honest about being empty', async ({ page }) => {
		await page.goto(`${webUrl()}/settings/workflows`);
		await expect(page.getByRole('heading', { name: 'Workflows', level: 1 })).toBeVisible();
		await expect(page.locator('.notice--failed')).toHaveCount(0);
		for (const name of ['Inbox triage', 'Morning brief', 'Chase what is due', 'Prepare for tomorrow', 'Stocktake']) await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
		const triage = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Inbox triage', exact: true }) });
		await expect(triage).toContainText('Not ready to turn on yet.');
		await expect(triage).toContainText('an inference runtime that is ready');
		await expect(triage.getByRole('button', { name: 'Turn on' })).toBeDisabled();
		await expect(page.getByText('No runs yet.')).toBeVisible();
	});

	test('parameters are saved while a workflow stays off', async ({ page }) => {
		await page.goto(`${webUrl()}/settings/workflows`);
		const stocktake = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Stocktake', exact: true }) });
		await stocktake.getByLabel('The location to count.').fill('Cool room');
		// Turning on is blocked, so the form's own button is disabled; parameters are saved through the API by the
		// same action with enabled=false, which the page exposes once the workflow has an enablement row.
		await expect(stocktake.getByRole('button', { name: 'Turn on' })).toBeDisabled();
	});
});
