import { defineConfig, devices } from '@playwright/test';

/** The smoke suite the deploy gates on. It runs against a deployment named by E2E_WEB_URL and
 *  E2E_API_URL, never a server it starts itself: what is proven is that what was just deployed
 *  answers correctly. Chromium only; a deploy gate is not a cross-browser suite. */
export default defineConfig({
	testDir: './tests', fullyParallel: true, forbidOnly: Boolean(process.env.CI), retries: process.env.CI ? 2 : 0,
	timeout: 30_000, expect: { timeout: 10_000 }, reporter: process.env.CI ? [['github'], ['list']] : [['list']],
	use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'phone', use: { ...devices['iPhone 14'] } }]
});
