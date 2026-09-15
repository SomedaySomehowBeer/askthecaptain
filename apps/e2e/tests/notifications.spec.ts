import { expect, test } from '@playwright/test';
import { webUrl } from '../targets.ts';

/** Settings → Notifications as a signed-in person. Needs E2E_SESSION_TOKEN; skipped, visibly, without one. */
const token = process.env.E2E_SESSION_TOKEN?.trim();

test.describe('notifications', () => {
	test.skip(!token, 'E2E_SESSION_TOKEN is not set; signed-in checks need a session');
	test.beforeEach(async ({ context }) => { await context.addCookies([{ name: 'captain_session', value: token!, url: webUrl() }]); });

	test('the page says honestly whether push is set up and what this device can do', async ({ page }) => {
		await page.goto(`${webUrl()}/settings/notifications`);
		await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
		await expect(page.locator('.notice--failed')).toHaveCount(0);
		const notConfigured = page.getByText('Push is not set up on this Captain yet.');
		const deviceState = page.getByText(/This device (receives|is not subscribed)|cannot receive pushes|Pushes need https|Notifications are blocked/);
		await expect(notConfigured.or(deviceState)).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Your devices' })).toBeVisible();
	});

	test('the service worker and manifest are served', async ({ request }) => {
		const sw = await request.get(`${webUrl()}/sw.js`);
		expect(sw.status()).toBe(200); expect(await sw.text()).toContain("addEventListener('push'");
		const manifest = await request.get(`${webUrl()}/manifest.webmanifest`);
		expect(manifest.status()).toBe(200); expect((await manifest.json()).name).toBe('Ask The Captain');
	});
});
