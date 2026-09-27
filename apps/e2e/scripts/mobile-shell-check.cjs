/** Mobile shell smoke check on the production Expo **web** export (mobile foundation contract §6, §10; M-shell).
 *
 *  This is a browser approximation of the native shell, not native proof. It runs React Native Web in Chromium at
 *  phone widths. It shows nothing about iOS or Android rendering, native stacks or gestures, safe areas, VoiceOver or
 *  TalkBack, text scaling, or device performance; those stay simulator and device evidence (§10).
 *
 *  It checks, at 360, 390 and 430 px wide:
 *  - exactly the Work, Chat and Resources tabs, with Work → My work as the default;
 *  - each tab keeps its own view and history; its header opens its grouped view list;
 *  - Inventory opens from the Resources view list, and browser back returns to that list;
 *  - Settings opens from the avatar, outside the tab bar, and goes back;
 *  - search and not-yet-built views are disabled; there are no business records, counts or dates;
 *  - an unknown or sign-in-callback link is refused without echoing it;
 *  - the approved tab bar geometry and selected pill, and 26 px headings;
 *  - no page errors, no horizontal overflow, and no request to any origin but the export.
 *
 *  Environment: MOBILE_SHELL_URL (default http://127.0.0.1:8092, a loopback static server for the export that serves
 *  index.html for unknown paths); CHROME_CDP_URL (a shared Chrome) or Playwright's Chromium; MOBILE_SHELL_SCREENSHOTS
 *  (optional directory for screenshots). Every request to the export is fetched through Playwright in Node, so a
 *  shared Chrome outside this network namespace still reaches it. Requests to any other origin are refused and fail the
 *  check. The browser context is this script's own and is closed; a shared Chrome is only disconnected. */
const { chromium, expect } = require('@playwright/test');
const { mkdir } = require('node:fs/promises');
const path = require('node:path');

const base = new URL(process.env.MOBILE_SHELL_URL ?? 'http://127.0.0.1:8092');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('MOBILE_SHELL_URL must be a loopback http origin');
const shots = process.env.MOBILE_SHELL_SCREENSHOTS;
const STEP_MS = 20_000;
const widths = [360, 390, 430];
/** A value placed in a refused link: it must never appear on the page. */
const canary = 'shellcanary7f3a';

function check(condition, message) { if (!condition) throw new Error(`check failed: ${message}`); }
const at = (page) => new URL(page.url()).pathname;
const approx = (actual, expected, tolerance) => Math.abs(actual - expected) <= tolerance;
/** The approved bar width (apps/mobile/src/theme/tokens.ts tabBarWidth): 80% of the screen less 22.4, within 240–360. */
const barWidth = (width) => Math.min(360, Math.max(240, width * 0.8 - 22.4));
/** Record names from the mockups and the fictional client proof: none of them may appear in the shell. */
const fictional = ['Summer lager', 'Packaging', 'Can artwork', 'Trade pack', 'Brewhouse', 'Fermenter', 'Canning line', 'Keg washer'];

(async () => {
	const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
	const contexts = []; let failed = false;
	if (shots) await mkdir(shots, { recursive: true });
	try {
		for (const width of widths) {
			const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
			contexts.push(context);
			const errors = []; const outside = new Set(); const consoleErrors = []; const history = [];
			await context.route(() => true, async (route) => {
				const url = new URL(route.request().url());
				if (url.origin !== base.origin) { outside.add(url.protocol === 'data:' ? 'data' : url.origin); await route.abort(); return; }
				await route.fulfill({ response: await route.fetch({ maxRedirects: 0 }) });
			});
			const page = await context.newPage(); page.setDefaultTimeout(STEP_MS);
			page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().replaceAll(canary, '[canary]')); });
			page.on('framenavigated', frame => { if (frame === page.mainFrame()) history.push(new URL(frame.url()).pathname); });
			page.on('pageerror', (error) => errors.push(error.message.replaceAll(canary, '[canary]')));
			const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${width}-${name}.png`), fullPage: true }); };
			const heading = (name) => page.getByRole('heading', { name, exact: true });
			const tab = (name) => page.getByRole('tab', { name, exact: true });
			const button = (name) => page.getByRole('button', { name, exact: true });
			const noOverflow = async (where) => {
				const over = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
				check(over <= 1, `${width}px ${where}: no horizontal overflow (${over}px)`);
			};
			/** Visible page text holds no digits (so no counts, dates or times) and no fictional record names. */
			const noRecords = async (where) => {
				const text = await page.evaluate(() => document.body.innerText);
				check(!/\d/.test(text), `${width}px ${where}: no numbers, counts, dates or times are shown`);
				for (const name of fictional) check(!text.includes(name), `${width}px ${where}: no fictional record is shown`);
			};
			const tabs = async (selected) => {
				const names = await page.getByRole('tab').evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).map((e) => e.getAttribute('aria-label')));
				check(names.join(',') === 'Work,Chat,Resources', `${width}px: exactly Work, Chat and Resources tabs (${names.join(',')})`);
				await expect(tab(selected)).toHaveAttribute('aria-selected', 'true');
			};
			const unavailable = async (label) => {
				const row = page.getByLabel(label, { exact: true });
				await expect(row).toBeVisible(); await expect(row).toHaveAttribute('aria-disabled', 'true');
			};

			try {
				// Default: Work → My work.
				await page.goto(base.href);
				await expect(heading('My work')).toBeVisible();
				check(at(page) === '/work', `${width}px: the app opens at /work`);
				await tabs('Work');
				await expect(page.getByText('Sign in to see your work', { exact: true })).toBeVisible();
				await expect(button('Search')).toHaveAttribute('aria-disabled', 'true');
				await noRecords('My work'); await noOverflow('My work');

				// The approved tab bar: about 80% of the width less 22.4, at least 54 high, 44 pt targets, the selected pill.
				const bar = await page.getByRole('tablist').boundingBox();
				check(bar && approx(bar.width, barWidth(width), 2) && bar.height >= 53.5, `${width}px: the floating tab bar keeps its approved size`);
				for (const name of ['Work', 'Chat', 'Resources']) { const box = await tab(name).boundingBox(); check(box && box.height >= 44 && box.width >= 44, `${width}px: the ${name} tab target is at least 44 px`); }
				const pill = await tab('Work').evaluate((e) => getComputedStyle(e).backgroundColor);
				check(pill.replaceAll(' ', '') === 'rgba(217,222,214,0.5)', `${width}px: the selected tab has the darker grey-green pill at 50%`);
				const size = await heading('My work').evaluate((e) => getComputedStyle(e).fontSize);
				check(size === '26px', `${width}px: screen headings are 26 px`);
				await shot('my-work');

				// Work's grouped view list is reached from its header; native placement beneath the view is device-only proof.
				await button('Work views').click();
				await expect(page.getByRole('heading', { name: /^for you$/i })).toBeVisible();
				check(at(page) === '/work/views', `${width}px: the Work view list is at /work/views`);
				for (const group of [/^across the business$/i, /^saved views$/i]) await expect(page.getByRole('heading', { name: group })).toBeVisible();
				await unavailable('All tasks. Not available in this build yet');
				await unavailable('By tag. Not available in this build yet');
				await unavailable('Your saved views. Not available in this build yet. Save views on the web.');
				await noRecords('Work views'); await noOverflow('Work views'); await shot('work-views');
				await page.getByRole('link', { name: 'My work. Assigned to you, across all tags', exact: true }).click();
				await expect(heading('My work')).toBeVisible();

				// Chat: its own default, then its own view list.
				await tab('Chat').click();
				await expect(heading('All conversations')).toBeVisible();
				check(at(page) === '/chat', `${width}px: Chat opens at /chat`);
				await tabs('Chat');
				await expect(page.getByText('Sign in to see your conversations', { exact: true })).toBeVisible();
				await button('Chat views').click();
				await expect(page.getByRole('heading', { name: /^conversations$/i })).toBeVisible();
				check(at(page) === '/chat/views', `${width}px: the Chat view list is at /chat/views`);
				await unavailable('Unread. Not available in this build yet');
				await unavailable('Starred. Not available in this build yet');
				await noRecords('Chat views'); await noOverflow('Chat views'); await shot('chat-views');

				// Tabs keep their own place: Work is still on My work, and Chat comes back to its view list.
				await tab('Work').click();
				await expect(heading('My work')).toBeVisible();
				check(at(page) === '/work', `${width}px: Work kept My work`);
				await tab('Chat').click();
				await expect(page.getByRole('heading', { name: /^conversations$/i })).toBeVisible();
				check(at(page) === '/chat/views', `${width}px: Chat kept its view list`);

				// Resources: the equipment schedule by default, Inventory from the view list, browser back to the list.
				await tab('Resources').click();
				await expect(heading('Equipment schedule')).toBeVisible();
				check(at(page) === '/resources', `${width}px: Resources opens at /resources`);
				await expect(page.getByText('Sign in to see the equipment schedule', { exact: true })).toBeVisible();
				await button('Resources views').click();
				await expect(page.getByRole('heading', { name: /^libraries$/i })).toBeVisible();
				await unavailable('Files & assets. Not available yet');
				await page.getByRole('link', { name: 'Inventory. Counted stock', exact: true }).click();
				await expect(heading('Inventory')).toBeVisible();
				check(at(page) === '/resources/inventory', `${width}px: Inventory is at /resources/inventory`);
				await expect(page.getByText('Sign in to see counted stock', { exact: true })).toBeVisible();
				await noRecords('Inventory'); await noOverflow('Inventory'); await shot('inventory');
				await page.goBack();
				await expect(page.getByRole('heading', { name: /^libraries$/i })).toBeVisible();
				check(at(page) === '/resources/views', `${width}px: browser back returns to the Resources view list`);

				// Settings opens from the avatar, outside the tabs, and goes back.
				await tab('Work').click();
				await expect(heading('My work')).toBeVisible();
				await button('Account and settings').click();
				await expect(heading('Account')).toBeVisible();
				check(at(page) === '/settings', `${width}px: Settings is at /settings`);
				await expect(page.getByRole('tablist')).toBeHidden();
				await expect(page.getByText('Not signed in', { exact: true })).toBeVisible();
				await noRecords('Settings'); await noOverflow('Settings'); await shot('settings');
				await button('Back').click();
				await expect(heading('My work')).toBeVisible();
				check(at(page) === '/work', `${width}px: Settings goes back to where it was opened`);

				// Links the shell does not have, including a sign-in callback, are refused without being echoed.
				for (const link of [`/work/tasks/0190c0de-0000-7000-8000-000000000000?code=${canary}`, `/auth/callback?code=nh_${canary}&attempt=${canary}`, `/${canary}`]) {
					await page.goto(new URL(link, base).href);
					await expect(heading('This link can’t be opened in Captain')).toBeVisible();
					const text = await page.evaluate(() => document.body.innerText);
					check(!text.includes(canary) && !text.includes('/work/tasks') && !text.includes('/auth/callback'), `${width}px: a refused link is not echoed`);
					await noOverflow('refused link');
				}
				await shot('refused-link');
				await button('Go to My work').click();
				await expect(heading('My work')).toBeVisible();

				check(errors.length === 0, `${width}px: no page errors (${errors.length})`);
				check(outside.size === 0, `${width}px: no request left the export's origin (${[...outside].join(', ')})`);
				console.log(`PASS ${width}px: three tabs, My work default, independent tab history, view lists, Inventory, Settings, disabled unavailable views, no records, refused links, no overflow or page errors`);
			} catch (error) {
				failed = true;
				console.error('navigation paths', JSON.stringify(history));
				console.error('console errors', JSON.stringify(consoleErrors));
				console.error('visible text', (await page.locator('body').innerText()).replaceAll(canary, '[canary]'));
				if (shots) await page.screenshot({ path: path.join(shots, `${width}-failure.png`), fullPage: true }).catch(() => undefined);
				for (const message of errors) console.error(`${width}px page error: ${message}`);
				throw error;
			}
		}
		console.log('PASS mobile shell web export smoke (a browser approximation; not native, simulator or device evidence)');
	} finally {
		for (const context of contexts) await context.close().catch(() => undefined);
		// For a shared Chrome this only disconnects; its other tabs and contexts are left alone.
		await browser.close().catch(() => undefined);
		if (failed) process.exitCode = 1;
	}
})().catch((error) => { console.error(String(error instanceof Error ? error.stack ?? error.message : error).replaceAll(canary, '[canary]')); process.exitCode = 1; });
