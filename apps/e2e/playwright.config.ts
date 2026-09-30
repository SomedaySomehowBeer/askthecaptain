import { defineConfig, devices } from '@playwright/test';

/** Manual deployment smoke: API liveness/readiness and the API-served Expo HTML at the supplied origins.
 *  The deploy workflow is disabled and no longer invokes this suite. Cookie-session browser regression checks
 *  run separately against fresh Expo exports through scripts/mobile-shell-ci.mjs in mobile.yml. */
export default defineConfig({
	testDir: './tests', testMatch: 'smoke.spec.ts', fullyParallel: true, forbidOnly: Boolean(process.env.CI), retries: process.env.CI ? 2 : 0,
	timeout: 30_000, expect: { timeout: 10_000 }, reporter: process.env.CI ? [['github'], ['list']] : [['list']],
	use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off' },
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'phone', use: { ...devices['Pixel 7'] } }]
});
