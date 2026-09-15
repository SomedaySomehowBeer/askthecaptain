import { expect, test } from '@playwright/test';
import { apiUrl, webUrl } from '../targets.ts';

test('the API is up and can reach its database', async ({ request }) => {
	expect((await request.get(`${apiUrl()}/healthz`)).status()).toBe(200);
	const ready = await request.get(`${apiUrl()}/readyz`);
	expect(ready.status()).toBe(200);
	expect(await ready.json()).toEqual({ ok: true });
});

test('signed-out people are sent to sign in, and the page is the real one', async ({ page }) => {
	await page.goto(`${webUrl()}/`);
	await expect(page).toHaveURL(/\/sign-in/);
	await expect(page).toHaveTitle(/Sign in · Ask The Captain/);
	await expect(page.getByRole('heading', { name: 'Ask The Captain' })).toBeVisible();
	// Either the sign-in action, or the honest statement that it is not configured; never a 500 shell.
	const action = page.getByRole('link', { name: 'Continue with Google' });
	const unconfigured = page.getByText('Sign-in is not set up.');
	await expect(action.or(unconfigured)).toBeVisible();
	// Next's route announcer carries role="alert", so the check is for the app's own failed state.
	await expect(page.locator('.notice--failed')).toHaveCount(0);
});

test('every area needs a session', async ({ request }) => {
	for (const path of ['/inbox', '/inbox/x', '/inbox/contacts/x', '/settings/contacts', '/commitments', '/calendar', '/settings', '/settings/members', '/settings/connections', '/settings/inference', '/settings/workflows', '/settings/notifications', '/settings/delete', '/settings/export', '/welcome']) {
		const response = await request.get(`${webUrl()}${path}`, { maxRedirects: 0 });
		expect(response.status(), path).toBe(307);
		expect(response.headers()['location'], path).toMatch(/\/sign-in/);
	}
});
