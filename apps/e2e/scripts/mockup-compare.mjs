/** Mockup comparison (H1 fidelity, D14): renders the client's screens and the reviewed mockups at 390 px and writes one
 *  side-by-side PNG per screen, so every client PR can show what changed against the designs the owner reviewed.
 *
 *  App side: the production and harness web exports (build them first, see apps/mobile/README.md "Local checks"),
 *  served on loopback and driven by the browser suite's own check modules with their synthetic API answers, which
 *  save their screenshots at the states named below. Mockup side: the chat-first prototype's frames
 *  (docs/proposals/assets/captain-chat-first-2026-09-30/index.html) and the R3 history-and-undo screens
 *  (docs/proposals/assets/captain-history-undo-2026-10-02/*.dc.html), the latter with the vendored Fraunces and Inter
 *  in place of Google Fonts and, for a dark pair, the dark tokens of apps/mobile/src/theme/tokens.ts in place of the
 *  light ones (the R3 README: "the dark scheme (use the dark tokens)"). Nothing leaves loopback.
 *
 *  Usage: node apps/e2e/scripts/mockup-compare.mjs <record> [name,name,...]
 *    writes docs/validation/<record>/compare/<name>.png.
 *  Run it under `flock /tmp/atc-build.lock` on a shared machine. */
import { createServer } from 'node:http';
import { readFile, readdir, stat, mkdir, copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(root, 'apps/e2e/package.json'));
const { chromium } = require('@playwright/test');
const scripts = path.join(root, 'apps/e2e/scripts');
const prototype = path.join(root, 'docs/proposals/assets/captain-chat-first-2026-09-30/index.html');
const r3 = path.join(root, 'docs/proposals/assets/captain-history-undo-2026-10-02');
const fonts = path.join(root, 'apps/mobile/assets/fonts');

/** Each screen: the app screenshot a check module saves (`<width>-<name>.png`), the mockup and a caption. `proto` is a
 *  prototype frame number (1-based, in the file's order); `r3` an R3 screen file; `dark` renders an R3 screen with the
 *  dark tokens. `crop` limits the mockup to its first N pixels when the frame is taller than its content. */
const screens = [
	{ name: 'list-light', app: 'threads-list', run: 'threads', proto: 1, caption: 'Thread list (light) / frame 1 Threads' },
	{ name: 'list-dark', app: 'dark-list', run: 'dark', proto: 15, caption: 'Thread list (dark) / frame 15 Threads home, dark' },
	{ name: 'new-thread', app: 'after-new', run: 'design', proto: 2, caption: 'New thread / frame 2 New thread' },
	{ name: 'thread-light', app: 'after-thread', run: 'design', proto: 3, caption: 'Task thread (light) / frame 3 Task thread' },
	{ name: 'thread-dark', app: 'dark-thread', run: 'dark', proto: 16, caption: 'Task thread (dark) / frame 16 Task thread, dark' },
	{ name: 'task-editing', app: 'cards-task-open', run: 'cards', r3: 'Main', caption: 'Task card, editing / R3 Main' },
	{ name: 'task-editing-dark', app: 'dark-cards-task-editing', run: 'cards-dark', r3: 'Main', dark: true, caption: 'Task card, editing (dark) / R3 Main in the dark tokens' },
	{ name: 'booking', app: 'cards-booking-open', run: 'cards', r3: 'Booking', caption: 'Booking card, editing / R3 Booking' },
	{ name: 'booking-cancel', app: 'cards-booking-cancel', run: 'cards', r3: 'Booking', caption: 'Booking cancel confirmation / R3 Booking' },
	{ name: 'lines', app: 'cards-lines', run: 'cards', r3: 'Lines', caption: 'Thread with change lines / R3 Lines' },
	{ name: 'folded-run', app: 'runs-folded', run: 'runs', r3: 'Lines', caption: 'Folded runs of change lines / R3 Lines (lines drawn one by one)' },
	{ name: 'topic-make-task', app: 'history-make-task', run: 'history', r3: 'Topic', caption: 'Topic: make this a task / R3 Topic' },
	{ name: 'history-light', app: 'history-states', run: 'history', r3: 'History', caption: 'History (light) / R3 History' },
	{ name: 'history-dark', app: 'dark-history-selected', run: 'history-dark', r3: 'Selected', dark: true, caption: 'History with ticks (dark) / R3 Selected in the dark tokens' },
	{ name: 'preview-dark', app: 'dark-history-preview', run: 'history-dark', r3: 'Preview', dark: true, caption: 'Preview (dark) / R3 Preview in the dark tokens' },
	{ name: 'selected', app: 'history-selected', run: 'history', r3: 'Selected', caption: 'History, two changes ticked / R3 Selected' },
	{ name: 'preview', app: 'history-preview', run: 'history', r3: 'Preview', caption: 'Preview / R3 Preview' },
	{ name: 'conflict', app: 'history-conflict', run: 'history', r3: 'Conflict', caption: 'Preview with a conflict / R3 Conflict' },
	{ name: 'blocked', app: 'history-blocked', run: 'history', r3: 'Blocked', caption: 'Preview, booking slot taken / R3 Blocked' },
	{ name: 'stale', app: 'history-stale', run: 'history', r3: 'Stale', caption: 'Preview that went out of date / R3 Stale' },
	{ name: 'applied', app: 'history-applied', run: 'history', r3: 'Applied', caption: 'History after an undo / R3 Applied' },
	{ name: 'equipment', app: 'light-equipment', run: 'dark', proto: 5, caption: 'Equipment schedule / frame 5 Equipment' },
	{ name: 'equipment-dark', app: 'dark-equipment', run: 'dark', proto: 5, protoDark: true, caption: 'Equipment schedule (dark) / frame 5 in the prototype dark tokens' },
	{ name: 'settings', app: 'light-settings', run: 'dark', proto: 13, caption: 'Settings / frame 13 Agent profile (profile layout)' },
	{ name: 'members', app: 'members-owner', run: 'members', proto: 12, caption: 'Members / frame 12 Team' },
	// H2 (bookings contract §3). New booking and the Equipment screen have no mockup of their own: each is compared with its
	// nearest board, as the contract says (board 2 for the booking fields, frame 12 for the list style).
	{ name: 'schedule-new-booking', app: 'bookings-schedule', run: 'bookings', proto: 5, caption: 'Schedule with New booking / frame 5 Equipment' },
	{ name: 'new-booking', app: 'bookings-new-booking', run: 'bookings', r3: 'Booking', caption: 'New booking (no mockup) / nearest: R3 Booking (board 2)' },
	{ name: 'new-booking-dark', app: 'dark-bookings-new-booking', run: 'bookings-dark', r3: 'Booking', dark: true, caption: 'New booking (dark, no mockup) / R3 Booking in the dark tokens' },
	{ name: 'new-booking-overlap', app: 'bookings-new-booking-overlap', run: 'bookings', r3: 'Booking', caption: 'New booking refused for an overlap (no mockup) / nearest: R3 Booking' },
	{ name: 'make-booking', app: 'bookings-make-booking', run: 'bookings', r3: 'Topic', caption: 'Topic: make this a booking / R3 Topic (board 3 pattern)' },
	{ name: 'make-booking-dark', app: 'dark-bookings-make-booking', run: 'bookings-dark', r3: 'Topic', dark: true, caption: 'Topic: make this a booking (dark) / R3 Topic in the dark tokens' },
	{ name: 'equipment-manage', app: 'bookings-manage', run: 'bookings', proto: 12, caption: 'Equipment screen (no mockup) / nearest: frame 12 Team' },
	{ name: 'equipment-manage-confirm', app: 'bookings-manage-confirm', run: 'bookings', proto: 12, caption: 'Equipment screen, archive confirm (no mockup) / nearest: frame 12 Team' },
	{ name: 'equipment-manage-dark', app: 'dark-bookings-manage', run: 'bookings-dark', proto: 12, protoDark: true, caption: 'Equipment screen (dark, no mockup) / frame 12 in the prototype dark tokens' },
	// H3 (stock contract §3): Stocktake is board 12; the stock card follows board 1 (the task card); the Stock filter's row is
	// frame 1's pinned rows. States the boards do not draw are compared with the nearest board.
	{ name: 'stocktake', app: 'stock-stocktake', run: 'stock', r3: 'Stocktake', caption: 'Stocktake, two counted / R3 Stocktake (board 12)' },
	{ name: 'stocktake-dark', app: 'dark-stock-stocktake', run: 'stock-dark', r3: 'Stocktake', dark: true, caption: 'Stocktake (dark) / R3 Stocktake in the dark tokens' },
	{ name: 'stocktake-stale', app: 'stock-stale', run: 'stock', r3: 'Stocktake', caption: 'Stocktake, a stale item marked (not drawn) / nearest: R3 Stocktake' },
	{ name: 'stocktake-uncertain', app: 'stock-uncertain', run: 'stock', r3: 'Stocktake', caption: 'Stocktake, an uncertain save (not drawn) / nearest: R3 Stocktake' },
	{ name: 'stocktake-add', app: 'stock-add', run: 'stock', r3: 'Stocktake', caption: 'Stocktake, Add an item (not drawn) / nearest: R3 Stocktake' },
	{ name: 'stock-card', app: 'stock-card', run: 'stock', r3: 'Main', caption: 'Stock card, editing / R3 Main (the task card pattern)' },
	{ name: 'stock-card-dark', app: 'dark-stock-card', run: 'stock-dark', r3: 'Main', dark: true, caption: 'Stock card (dark) / R3 Main in the dark tokens' },
	{ name: 'stock-archive-confirm', app: 'stock-archive-confirm', run: 'stock', r3: 'Main', caption: 'Stock card, archive confirm (not drawn) / nearest: R3 Main' },
	{ name: 'stock-filter', app: 'stock-filter', run: 'stock', proto: 1, caption: 'Stock filter with the Stocktake row / frame 1 Threads (pinned rows)' },
	{ name: 'stock-saved', app: 'stock-saved', run: 'stock', proto: 1, caption: 'Thread list after a stocktake (not drawn) / frame 1 Threads' }
];

/** The check modules that produce the app screenshots, each run once at 390 px. */
const runs = {
	threads: c => require(path.join(scripts, 'mobile-shell-threads-check.cjs'))(c),
	design: c => require(path.join(scripts, 'mobile-shell-design-check.cjs'))(c),
	dark: c => require(path.join(scripts, 'mobile-shell-dark-check.cjs'))(c),
	cards: c => require(path.join(scripts, 'mobile-shell-cards-check.cjs'))(c),
	'cards-dark': c => require(path.join(scripts, 'mobile-shell-cards-check.cjs'))({ ...c, scheme: 'dark' }),
	history: c => require(path.join(scripts, 'mobile-shell-history-check.cjs'))(c),
	'history-dark': c => require(path.join(scripts, 'mobile-shell-history-check.cjs'))({ ...c, scheme: 'dark' }),
	members: c => require(path.join(scripts, 'mobile-shell-members-check.cjs'))(c),
	runs: c => require(path.join(scripts, 'mobile-shell-runs-check.cjs'))(c),
	bookings: c => require(path.join(scripts, 'mobile-shell-bookings-check.cjs'))(c),
	'bookings-dark': c => require(path.join(scripts, 'mobile-shell-bookings-check.cjs'))({ ...c, scheme: 'dark' }),
	stock: c => require(path.join(scripts, 'mobile-shell-stock-check.cjs'))(c),
	'stock-dark': c => require(path.join(scripts, 'mobile-shell-stock-check.cjs'))({ ...c, scheme: 'dark' })
};

/** The harness's test controls (harness/app/_layout.tsx) are not app UI: hidden in every screenshot the check modules
 *  take for this comparison, through Playwright's screenshot `style`, so the checks themselves still press them. */
const harnessMarker = 'CAPTAIN_MOBILE_HARNESS_7f3a';
function hidingHarness(browser) {
	return new Proxy(browser, { get(target, key) {
		if (key !== 'newContext') { const value = target[key]; return typeof value === 'function' ? value.bind(target) : value; }
		return async (...args) => {
			const context = await target.newContext(...args);
			const newPage = context.newPage.bind(context);
			context.newPage = async (...more) => {
				const page = await newPage(...more);
				const screenshot = page.screenshot.bind(page);
				// The faces swap in when loaded; a comparison waits for them.
				page.screenshot = async (options = {}) => { await page.evaluate(() => document.fonts.ready).catch(() => {}); return screenshot({ ...options, style: `${options.style ?? ''}[data-testid="${harnessMarker}"]{display:none!important}` }); };
				return page;
			};
			return context;
		};
	} });
}

const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ttf': 'font/ttf' };
async function serve(relative) {
	const files = path.join(root, relative);
	await stat(path.join(files, 'index.html'));
	const server = createServer(async (request, response) => {
		try {
			const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
			let file = path.resolve(files, '.' + pathname);
			if (!file.startsWith(files + path.sep) && file !== files) { response.writeHead(400).end(); return; }
			if (!(await stat(file).then(s => s.isFile(), () => false))) file = path.join(files, 'index.html');
			response.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
			response.end(await readFile(file));
		} catch { response.writeHead(500).end(); }
	});
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	return { server, url: new URL(`http://127.0.0.1:${server.address().port}`) };
}

/** The palettes from tokens.ts, as light hex → dark hex, plus the prototype's dark values for the R3 colours tokens.ts
 *  does not name (its `.screen.dark` custom properties: line-strong, action-hover, warn ink). */
async function darkMap() {
	const source = await readFile(path.join(root, 'apps/mobile/src/theme/tokens.ts'), 'utf8');
	const palette = name => Object.fromEntries([...source.split(`export const ${name}: Palette = {`)[1].split('};')[0].matchAll(/(\w+): '([^']+)'/g)].map(m => [m[1], m[2]]));
	const light = palette('light'), dark = palette('dark'), map = new Map();
	for (const key of Object.keys(light)) if (light[key].startsWith('#') && !map.has(light[key].toLowerCase())) map.set(light[key].toLowerCase(), dark[key]);
	for (const [from, to] of [['#c6d2c1', '#3a4a40'], ['#1f5638', '#a8f0ba'], ['#3f2c06', '#fbe8c4'], ['#fff', dark.card]]) if (!map.has(from)) map.set(from, to);
	return map;
}

async function main() {
	const [record, only] = process.argv.slice(2);
	if (!record || !/^[a-z0-9-]+$/.test(record)) throw new Error('usage: node apps/e2e/scripts/mockup-compare.mjs <record> [name,name,...]');
	const chosen = only ? screens.filter(s => only.split(',').includes(s.name)) : screens;
	if (only && chosen.length !== only.split(',').length) throw new Error(`unknown screen in ${only}; known: ${screens.map(s => s.name).join(', ')}`);
	const out = path.join(root, 'docs/validation', record, 'compare');
	const shots = path.join(tmpdir(), `captain-mockup-compare-${process.pid}`), parts = path.join(shots, 'parts');
	await mkdir(out, { recursive: true });
	await mkdir(parts, { recursive: true }); await mkdir(shots, { recursive: true });
	const servers = [];
	const browser = await chromium.launch();
	try {
		const production = await serve('apps/mobile/dist/web'); servers.push(production.server);
		const harness = await serve('apps/mobile/dist-harness'); servers.push(harness.server);
		// App side: each needed check module once, saving its screenshots.
		for (const run of [...new Set(chosen.map(s => s.run))]) {
			console.log(`app: ${run}`);
			await runs[run]({ browser: hidingHarness(browser), production: production.url, base: harness.url, shots, width: 390 });
		}
		const saved = await readdir(shots);
		for (const s of chosen) {
			if (!saved.includes(`390-${s.app}.png`)) throw new Error(`no app screenshot 390-${s.app}.png for ${s.name}; saved: ${saved.sort().join(' ')}`);
			await copyFile(path.join(shots, `390-${s.app}.png`), path.join(parts, `${s.name}-app.png`));
		}

		// Mockup side.
		const fontCss = ['Fraunces-SemiBold:Fraunces:600:fraunces', 'Inter-Regular:Inter:400:inter', 'Inter-SemiBold:Inter:600:inter', 'Inter-Bold:Inter:700:inter']
			.map(f => { const [file, family, weight, dir] = f.split(':'); return `@font-face{font-family:${family};font-weight:${weight};src:url(${pathToFileURL(path.join(fonts, dir, `${file}.ttf`)).href})}`; }).join('\n');
		const dark = await darkMap();
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
		const page = await context.newPage();
		await context.route('**/*', async route => {
			const url = new URL(route.request().url());
			if (url.protocol === 'file:' || url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
			if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: fontCss });
			return route.abort();
		});
		for (const s of chosen) {
			const target = path.join(parts, `${s.name}-mockup.png`);
			if (s.r3) {
				await page.setViewportSize({ width: 390, height: 844 });
				await page.goto(pathToFileURL(path.join(r3, `${s.r3}.dc.html`)).href);
				if (s.dark) {
					const css = (await readFile(path.join(r3, 'captain.css'), 'utf8')).replace(/#[0-9a-fA-F]{6}\b|#fff\b/g, hex => dark.get(hex.toLowerCase()) ?? hex).replace('rgba(20,38,25,.5)', 'rgba(0,0,0,.6)');
					await page.evaluate(([text, map]) => {
						for (const link of document.querySelectorAll('link[href="./captain.css"]')) link.remove();
						const style = document.createElement('style'); style.textContent = text; document.head.append(style);
						const swap = value => value.replace(/#[0-9a-fA-F]{6}\b|#fff\b/g, hex => map[hex.toLowerCase()] ?? hex);
						for (const el of document.querySelectorAll('[style]')) el.setAttribute('style', swap(el.getAttribute('style')));
						// A board's own rules (board 12 keeps its row and field styles in the page) take the same swap.
						for (const own of document.querySelectorAll('style')) if (own !== style) own.textContent = swap(own.textContent);
					}, [css, Object.fromEntries(dark)]);
				}
				await page.evaluate(() => document.fonts.ready);
				await page.locator('.screen').first().screenshot({ path: target });
			} else {
				await page.setViewportSize({ width: 500, height: 1000 });
				await page.goto(pathToFileURL(prototype).href);
				const frames = page.locator('section.board iframe');
				await frames.nth(16).waitFor({ state: 'attached', timeout: 30000 });
				const frame = frames.nth(s.proto - 1);
				await frame.scrollIntoViewIfNeeded();
				const inner = await (await frame.elementHandle()).contentFrame();
				await inner.waitForFunction(() => document.fonts.status === 'loaded' && document.querySelector('.screen'));
				if (s.protoDark) await inner.evaluate(() => document.querySelector('.screen').classList.add('dark'));
				await page.waitForTimeout(300);
				await frame.screenshot({ path: target });
			}
		}
		await context.close();

		// Side by side: one page with both images at their own size.
		const sheet = await browser.newContext({ viewport: { width: 850, height: 900 } });
		const compose = await sheet.newPage();
		for (const s of chosen) {
			const uri = async file => `data:image/png;base64,${(await readFile(file)).toString('base64')}`;
			const [app, mock] = [await uri(path.join(parts, `${s.name}-app.png`)), await uri(path.join(parts, `${s.name}-mockup.png`))];
			await compose.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#fff;font:13px/1.4 system-ui,sans-serif;color:#222}
				h1{font-size:14px;margin:10px 16px 6px} .row{display:flex;gap:30px;padding:0 16px 16px;align-items:flex-start}
				figure{margin:0;width:390px} figcaption{font-weight:600;margin-bottom:6px} img{display:block;width:390px;outline:1px solid #ccc}</style>
				<h1>${s.caption}</h1><div class="row"><figure><figcaption>App (390 px export)</figcaption><img src="${app}"></figure>
				<figure><figcaption>Mockup</figcaption><img src="${mock}"></figure></div>`);
			await compose.evaluate(() => Promise.all([...document.images].map(i => i.decode())));
			await compose.screenshot({ path: path.join(out, `${s.name}.png`), fullPage: true });
			console.log(`wrote ${path.relative(root, path.join(out, `${s.name}.png`))}`);
		}
		await sheet.close();
	} finally {
		await browser.close();
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		await rm(shots, { recursive: true, force: true });
	}
}

await main();
