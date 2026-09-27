/** Native sign-in browser proof (mobile foundation contract §3.5 and §9, A2). Local real-Postgres fixture only:
 *  apps/api/test/native-fixture.ts on 127.0.0.1 with synthetic people, the production web build on localhost, a fake
 *  Google and a virtual WebAuthn authenticator. No real account, provider or hosted service is touched.
 *
 *  This script plays the mobile app: it makes a PKCE verifier and attempt, opens the native start in the browser,
 *  captures the handoff the web sends to the app's constant callback, and spends it at /auth/native/exchange.
 *  It never prints a URL, code, token, verifier or attempt, including in failures.
 *
 *  Browser: CHROME_CDP_URL (a shared Chrome) or Playwright's Chromium. Every request to the two loopback origins is
 *  fetched through Playwright, so a shared Chrome outside this network namespace still reaches them, and a redirect to
 *  the app's scheme is recorded instead of followed. */
const { chromium, expect } = require('@playwright/test');
const { readFile, mkdir } = require('node:fs/promises');
const { createHash, randomBytes } = require('node:crypto');
const path = require('node:path');

const directory = process.env.NATIVE_PROBE_DIR;
if (!directory) throw Error('NATIVE_PROBE_DIR is required');
/** The checked-in callback constant (contract §3.2 step 5). */
const SCHEME = 'app.askthecaptain.dev:';
const STEP_MS = 20_000;

const secrets = new Set();
const keep = (...values) => { for (const value of values) if (typeof value === 'string' && value.length >= 8) secrets.add(value); return values[0]; };
/** Strips known secrets, prefixed codes/tokens, any long base64url run and sensitive query values. */
function redact(text) {
	let clean = String(text);
	for (const secret of secrets) clean = clean.split(secret).join('[redacted]');
	return clean
		.replace(/\b(?:nh|x|pks|pkr|sess|st|n|v)_[A-Za-z0-9_-]{16,}/g, '[redacted]')
		.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, '[redacted]')
		.replace(/\b(code|attempt|token|state|code_challenge|verifier)=[^&\s"'<>]+/g, '$1=[redacted]');
}
/** Assertions whose messages never carry the values compared. */
function check(condition, message) { if (!condition) throw new Error(`check failed: ${message}`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(message, test, limitMs = STEP_MS) {
	const deadline = Date.now() + limitMs;
	for (;;) { if (await test()) return; if (Date.now() > deadline) throw new Error(`timed out: ${message}`); await sleep(100); }
}
const b64url = (buffer) => buffer.toString('base64url');

(async () => {
	const f = JSON.parse(await readFile(path.join(directory, 'data.json'), 'utf8'));
	check(f.fixture === 'captain-native-local', 'the native fixture data');
	for (const user of Object.values(f.users)) keep(user.token);
	const api = new URL(f.api), web = new URL(f.web);
	check(api.hostname === '127.0.0.1' && web.hostname === 'localhost', 'loopback origins only');
	const control = async (route, body) => { const response = await fetch(new URL(route, api), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); check(response.ok, `fixture control ${route}`); };
	const asPerson = (who) => control('/__fixture/identity', { who });
	const setNative = (enabled) => control('/__fixture/native', { enabled });
	const me = async (token) => { const response = await fetch(new URL('/v1/me', api), { headers: { authorization: `Bearer ${token}` } }); return { status: response.status, body: response.ok ? await response.json() : null }; };

	const browser = process.env.CHROME_CDP_URL ? await chromium.connectOverCDP(process.env.CHROME_CDP_URL) : await chromium.launch();
	const errors = [], contexts = [], tabs = [];
	await mkdir(directory, { recursive: true });

	/** A context whose loopback traffic goes through Playwright; records every handoff to the app scheme. */
	async function open(name) {
		const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(context);
		const handoffs = []; const hooks = new Map(); const handoffResponses = [];
		/** Sanitised request trail for failures: method, which origin, path and status only. No query, header or body. */
		const trail = [];
		const note = (request, url, status) => { trail.push(`${request.method()} ${url.origin === api.origin ? 'api' : 'web'} ${url.pathname} ${status}`); if (trail.length > 80) trail.shift(); };
		const record = (url) => { if (typeof url === 'string' && url.startsWith(SCHEME) && !handoffs.includes(url)) handoffs.push(url); };
		await context.route((url) => url.origin === api.origin || url.origin === web.origin, async (route) => {
			const request = route.request(); const url = new URL(request.url());
			const hook = hooks.get(`${url.origin}${url.pathname}`); if (hook) { hooks.delete(`${url.origin}${url.pathname}`); await hook(); }
			let response;
			try { response = await route.fetch({ maxRedirects: 0 }); } catch (error) { note(request, url, 'fetch-failed'); throw error; }
			const location = response.headers().location; const status = response.status();
			note(request, url, status);
			// Cookie names only (never values) that this response tried to set, so a lost session cookie shows in the trail.
			const setNames = response.headersArray().filter(({ name }) => name.toLowerCase() === 'set-cookie').map(({ value }) => value.split('=')[0].trim()).filter((n) => /^[A-Za-z0-9_-]{1,40}$/.test(n));
			if (setNames.length) trail[trail.length - 1] += ` set-cookie:${setNames.join(',')}`;
			if (location && status >= 300 && status < 400) {
				const target = new URL(location, request.url()).href;
				// Keep Set-Cookie and every other header except the redirect itself, so cookie behaviour is the real one.
				// route.fulfill takes an object; repeated Set-Cookie values are joined with newlines, others with commas.
				const headers = {};
				for (const { name, value } of response.headersArray()) {
					const key = name.toLowerCase();
					if (['location', 'content-length', 'content-encoding', 'content-type'].includes(key)) continue;
					headers[key] = key in headers ? `${headers[key]}${key === 'set-cookie' ? '\n' : ', '}${value}` : value;
				}
				headers['content-type'] = 'text/html';
				if (target.startsWith(SCHEME)) {
					record(target);
					// The web's own redirect to the app, as sent: its status and the headers that keep the code out of caches and referrers.
					const sent = response.headers();
					handoffResponses.push({ status, cacheControl: sent['cache-control'] ?? '', referrerPolicy: sent['referrer-policy'] ?? '', setsCookie: response.headersArray().some(({ name }) => name.toLowerCase() === 'set-cookie') });
					await route.fulfill({ status: 200, headers, body: '<!doctype html><title>Handoff captured</title><p>Returned to the app.</p>' });
					return;
				}
				if (request.isNavigationRequest()) {
					await route.fulfill({ status: 200, headers, body: `<!doctype html><script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script>` });
					return;
				}
			}
			await route.fulfill({ response });
		});
		const page = await context.newPage(); page.setDefaultTimeout(STEP_MS);
		page.on('pageerror', (error) => errors.push(`${name}: ${redact(error.message)}`));
		const cdp = await context.newCDPSession(page);
		await cdp.send('Page.enable');
		// A page-initiated navigation to the app scheme (the passkey path's location.assign) never reaches the router.
		for (const event of ['Page.frameRequestedNavigation', 'Page.frameStartedNavigating']) cdp.on(event, (e) => record(e.url));
		const anchors = async () => { for (const href of await page.locator(`a[href^="${SCHEME}"]`).evaluateAll((links) => links.map((a) => a.getAttribute('href'))).catch(() => [])) record(href); };
		const session = async () => (await context.cookies(web.origin)).find((c) => c.name === 'captain_session')?.value;
		const at = () => { try { const u = new URL(page.url()); return { origin: u.origin, path: u.pathname, params: u.searchParams }; } catch { return { origin: '', path: '', params: new URLSearchParams() }; } };
		const tab = { name, context, page, cdp, handoffs, handoffResponses, hooks, anchors, session, at, trail };
		tabs.push(tab);
		return tab;
	}

	function attemptOf() {
		const verifier = b64url(randomBytes(32)), attempt = b64url(randomBytes(32));
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		keep(verifier, attempt, challenge);
		return { verifier, attempt, challenge };
	}
	const nativeStart = (a, overrides = {}) => {
		const url = new URL('/auth/google/start', api);
		for (const [key, value] of Object.entries({ client: 'native', code_challenge: a.challenge, code_challenge_method: 'S256', attempt: a.attempt, return_to: '/work', ...overrides })) if (value !== null) url.searchParams.set(key, value);
		return url.toString();
	};
	/** The handoff the web sent: exactly the constant callback with one code and the matching attempt, nothing else. */
	function handoffOf(tab, a) {
		check(tab.handoffs.length === 1, `exactly one handoff (${tab.handoffs.length})`);
		const target = new URL(tab.handoffs[0]);
		check(target.protocol === SCHEME && target.host === '' && target.pathname === '/auth/callback', 'the handoff goes to the constant app callback');
		check([...target.searchParams.keys()].sort().join(',') === 'attempt,code', 'the handoff carries only a code and the attempt');
		const code = keep(target.searchParams.get('code'));
		check(/^nh_[A-Za-z0-9_-]{43}$/.test(code ?? ''), 'the handoff code has the native handoff shape');
		check(target.searchParams.get('attempt') === a.attempt, 'the handoff echoes this attempt');
		return code;
	}
	/** The app's leg: spend the handoff with the verifier and attempt it kept. */
	async function spend(code, a) {
		const response = await fetch(new URL('/auth/native/exchange', api), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, verifier: a.verifier, attempt: a.attempt }) });
		const body = await response.json().catch(() => ({}));
		if (typeof body.token === 'string') keep(body.token);
		return { status: response.status, body };
	}
	async function noHandoffFor(tab, ms) { const deadline = Date.now() + ms; while (Date.now() < deadline) { await tab.anchors(); check(tab.handoffs.length === 0, 'no handoff was sent'); await sleep(200); } }

	try {
		await setNative(true);

		// 1. Native, no passkey: the web's only output is the app callback; the browser gets no session cookie.
		{
			const tab = await open('native-no-passkey'); const a = attemptOf();
			await asPerson('nora'); await tab.page.goto(nativeStart(a));
			await until('the no-passkey handoff', async () => { await tab.anchors(); return tab.handoffs.length > 0; });
			const code = handoffOf(tab, a);
			check(tab.handoffResponses.length === 1, 'the no-passkey handoff is the web callback’s own redirect');
			const [sent] = tab.handoffResponses;
			check(sent.status === 303, 'the handoff redirect is a 303');
			check(/\bno-store\b/.test(sent.cacheControl), 'the handoff redirect is not cached (cache-control: no-store)');
			check(sent.referrerPolicy.trim().toLowerCase() === 'no-referrer', 'the handoff redirect sends no referrer');
			check(!sent.setsCookie, 'the handoff redirect sets no cookie');
			check((await tab.session()) === undefined, 'no web session cookie after a native sign-in');
			const spent = await spend(code, a);
			check(spent.status === 200 && /^sess_/.test(spent.body.token ?? '') && spent.body.returnTo === '/work', 'the app spends the handoff for a session');
			const who = await me(spent.body.token);
			check(who.status === 200 && who.body.user.email === f.users.nora.email && who.body.passkeyVerified === false, 'the native session is Nora’s, without a passkey');
			check((await spend(code, a)).status === 401, 'the handoff is single use');
			check((await tab.session()) === undefined, 'still no web session cookie');
			console.log('PASS native without a passkey: constant app callback with code and attempt only, 303 no-store/no-referrer, no web cookie, app exchange once');
		}

		// 1b. The same native sign-in in a browser that already holds someone else's web session: that cookie is left
		//     exactly as it was and still works; the app still gets only its own handoff.
		{
			const tab = await open('native-no-passkey-other-cookie'); const a = attemptOf();
			await tab.context.addCookies([{ name: 'captain_session', value: f.users.olive.token, url: web.origin }]);
			await asPerson('nora'); await tab.page.goto(nativeStart(a));
			await until('the no-passkey handoff beside another web session', async () => { await tab.anchors(); return tab.handoffs.length > 0; });
			const code = handoffOf(tab, a);
			check(tab.handoffResponses.length === 1 && !tab.handoffResponses[0].setsCookie, 'the handoff redirect sets no cookie');
			check((await tab.session()) === f.users.olive.token, 'the unrelated web session cookie is unchanged');
			const spent = await spend(code, a);
			check(spent.status === 200, 'the app spends the handoff');
			const who = await me(spent.body.token);
			check(who.status === 200 && who.body.user.email === f.users.nora.email, 'the native session is Nora’s, not the browser’s other session');
			const other = await me(f.users.olive.token);
			check(other.status === 200 && other.body.user.email === f.users.olive.email, 'Olive’s web session still works');
			check((await tab.session()) === f.users.olive.token, 'the unrelated web session cookie is still unchanged');
			console.log('PASS native without a passkey beside an unrelated web session: that cookie unchanged and still valid, handoff to the app only');
		}

		// 2. The ordinary web sign-in still ends in the web session cookie and never in a handoff.
		{
			const tab = await open('web-no-passkey');
			await asPerson('nora'); await tab.page.goto(new URL('/sign-in?return_to=%2Fwork', web).toString());
			await tab.page.getByRole('link', { name: 'Continue with Google', exact: true }).click();
			await until('the web session cookie', async () => /^sess_/.test(keep(await tab.session()) ?? ''));
			await until('leaving sign-in', async () => tab.at().origin === web.origin && !['/sign-in', '/auth/callback'].includes(tab.at().path));
			const who = await me(await tab.session());
			check(who.status === 200 && who.body.user.email === f.users.nora.email, 'the web cookie is Nora’s session');
			await noHandoffFor(tab, 1000);
			console.log('PASS web sign-in unchanged: session cookie, no app handoff');
		}

		// 3. Required passkey: registered through Settings with a virtual authenticator; a native sign-in, even in a browser
		//    holding someone else's web session, cannot reach the app without the passkey, then does, without a web cookie.
		{
			const tab = await open('native-passkey');
			await tab.cdp.send('WebAuthn.enable', { enableUI: false });
			const { authenticatorId } = await tab.cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
			await tab.context.addCookies([{ name: 'captain_session', value: f.users.pat.token, url: web.origin }]);
			await tab.page.goto(new URL('/settings/passkeys', web).toString());
			await tab.page.getByRole('button', { name: 'Add a passkey for this device', exact: true }).click();
			await expect(tab.page.getByRole('status').filter({ hasText: 'Added.' })).toBeVisible();
			console.log('PASS passkey registered for Pat through Settings with a virtual authenticator');

			// Exercise the web control before intercepting external navigation, keeping this page's authenticator.
			// Earlier runs after the native handoff loaded /sign-in but its click never reached the API. The cause
			// is not established; this independent web control must not depend on that intercepted app navigation.
			await tab.context.clearCookies();
			await asPerson('pat'); await tab.page.goto(new URL('/sign-in?return_to=%2Fwork', web).toString());
			await tab.page.getByRole('link', { name: 'Continue with Google', exact: true }).click();
			await until('the web session cookie after the passkey', async () => /^sess_/.test(keep(await tab.session()) ?? ''));
			const signed = await me(await tab.session());
			check(signed.status === 200 && signed.body.user.email === f.users.pat.email && signed.body.passkeyVerified === true, 'the web step-up ends in Pat’s passkey-verified web session');
			await noHandoffFor(tab, 1000);
			console.log('PASS web sign-in with a passkey unchanged: step-up, then the web session cookie, no app handoff');

			await tab.context.clearCookies();
			await tab.context.addCookies([{ name: 'captain_session', value: f.users.olive.token, url: web.origin }]);
			await tab.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
			const a = attemptOf();
			await asPerson('pat'); await tab.page.goto(nativeStart(a, { return_to: '/chat' }));
			await until('the passkey step-up page', async () => tab.at().origin === web.origin && tab.at().path === '/auth/passkey');
			check(/^pks_/.test(keep(tab.at().params.get('token')) ?? '') && tab.at().params.get('native') === '1', 'the step-up page is marked native and carries a step-up token');
			await noHandoffFor(tab, 4000);
			check(tab.at().path === '/auth/passkey', 'an unrelated signed-in browser stays on the step-up');
			check((await tab.session()) === f.users.olive.token, 'the unrelated web session is untouched while the passkey is pending');
			console.log('PASS native with a required passkey: no handoff and no skip while the passkey is not presented, despite another web session');

			await tab.cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
			await tab.page.reload();
			await until('the passkey handoff', async () => { await tab.anchors(); return tab.handoffs.length > 0; });
			const code = handoffOf(tab, a);
			check((await tab.session()) === f.users.olive.token, 'the native step-up issued no web session and replaced no cookie');
			const spent = await spend(code, a);
			check(spent.status === 200 && spent.body.returnTo === '/chat', 'the app spends the passkey handoff');
			const who = await me(spent.body.token);
			check(who.status === 200 && who.body.user.email === f.users.pat.email && who.body.passkeyVerified === true, 'the native session is Pat’s and passkey-verified');
			const other = await me(f.users.olive.token);
			check(other.status === 200 && other.body.user.email === f.users.olive.email, 'Olive’s web session still works');
			console.log('PASS native passkey step-up ends in the app callback, passkey-verified, with the browser’s web session unchanged');
		}

		// 4. Disabled or invalid native requests: no cookie and no app destination, at every stage.
		{
			const tab = await open('native-refused');
			const refusedAt = async (label) => {
				await noHandoffFor(tab, 1000);
				check((await tab.session()) === undefined, `${label}: no web session cookie`);
			};
			await setNative(false);
			const off = await tab.page.goto(nativeStart(attemptOf()));
			check(off?.status() === 400 && tab.at().origin === api.origin, 'a native start while off is refused by the API');
			await refusedAt('start while off');

			await setNative(true);
			const invalid = await tab.page.goto(nativeStart(attemptOf(), { code_challenge: 'short' }));
			check(invalid?.status() === 400 && tab.at().origin === api.origin, 'an invalid native start is refused by the API');
			await refusedAt('invalid start');

			/** The sign-in page names the disabled mobile sign-in, in the words a person sees. */
			const disabledShown = async (label) => {
				check(tab.at().params.get('error') === 'native_sign_in_disabled', `${label}: the sign-in page is told mobile sign-in is disabled`);
				await expect(tab.page.getByText('Signing in from the Captain app is not available on this Captain.', { exact: false })).toBeVisible();
			};

			// Started while on; mobile sign-in is switched off before Google returns to the API.
			tab.hooks.set(`${api.origin}/auth/google/callback`, () => setNative(false));
			await asPerson('nora'); await tab.page.goto(nativeStart(attemptOf()));
			await until('sign-in after a disabled callback', async () => tab.at().origin === web.origin && tab.at().path === '/sign-in');
			await disabledShown('disabled at the callback');
			await refusedAt('disabled at the callback');

			// Started and returned while on; switched off before the web spends the exchange code.
			await setNative(true);
			tab.hooks.set(`${web.origin}/auth/callback`, () => setNative(false));
			await tab.page.goto(nativeStart(attemptOf()));
			await until('sign-in after a disabled exchange', async () => tab.at().origin === web.origin && tab.at().path === '/sign-in');
			await disabledShown('disabled at the web exchange');
			await refusedAt('disabled at the web exchange');
			await setNative(true);
			console.log('PASS disabled and invalid native requests: no web cookie and no app handoff at start, callback or exchange; the disabled cases name themselves on sign-in');
		}

		check(errors.length === 0, `no browser exceptions (${errors.length})`);
		console.log('PASS no browser exceptions');
	} catch (error) {
		for (const [index, context] of contexts.entries()) for (const page of context.pages()) await page.screenshot({ path: path.join(directory, `failure-${index}.png`), fullPage: true }).catch(() => {});
		for (const message of errors) console.error(message);
		// Sanitised diagnostics: the last requests per tab (method, origin, path, status, names of cookies set), the final
		// page path and the names of the cookies the browser holds. No query, header value, body or cookie value.
		for (const [index, tab] of tabs.entries()) {
			const names = await tab.context.cookies(web.origin).then((cookies) => cookies.map((c) => c.name).filter((n) => /^[A-Za-z0-9_-]{1,40}$/.test(n)).sort(), () => ['(unreadable)']);
			console.error(`diagnostics tab ${index} (${tab.name}): final ${tab.at().origin === api.origin ? 'api' : tab.at().origin === web.origin ? 'web' : 'other'} ${tab.at().path || '(none)'}; web cookies ${names.length} [${names.join(', ')}]; handoffs ${tab.handoffs.length}`);
			for (const line of tab.trail.slice(-40)) console.error(`  ${line}`);
		}
		throw error;
	} finally {
		await setNative(true).catch(() => {});
		for (const context of contexts) await context.close().catch(() => {});
		// For a shared Chrome this only disconnects; its other tabs and contexts are left alone.
		await browser.close().catch(() => {});
	}
})().catch((error) => { console.error(redact(error instanceof Error ? error.stack ?? error.message : error)); process.exitCode = 1; });
