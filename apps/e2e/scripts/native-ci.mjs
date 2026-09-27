/** Runner for the native sign-in browser proof (native-check.cjs; mobile foundation contract §3.5, A2). No dependencies.
 *
 *  Expects the production web build to exist already and DATABASE_URL to name a loopback Postgres admin connection.
 *  - starts `next start` on 127.0.0.1:3036 with APP_URL=http://localhost:3036 (WebAuthn refuses an IP address as a
 *    relying party, so the browser uses `localhost`) and API_URL=http://127.0.0.1:8086;
 *  - starts apps/api/test/native-fixture.ts (its own disposable database) on 127.0.0.1:8086 in a private directory;
 *  - runs native-check.cjs with a time limit, then stops the fixture and waits for its cleanup (database dropped,
 *    data.json removed);
 *  - keeps only screenshots and logs, redacted of every code, token, verifier and attempt, under NATIVE_CI_OUT
 *    (default apps/e2e/chat-ci-output/native-sign-in, inside the existing CI artifact). data.json never leaves /tmp.
 *  Every child runs in its own process group and is stopped on exit, failure, timeout or signal. Set CHROME_CDP_URL to
 *  use a shared Chrome locally; otherwise Playwright's Chromium is launched. Exit code 0 only when the proof passed. */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, copyFile, mkdir, rm, writeFile, access, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.resolve(process.env.NATIVE_CI_OUT ?? path.join(root, 'apps/e2e/chat-ci-output/native-sign-in'));
const maxSuiteMs = 8 * 60_000;
const askedMs = Number(process.env.NATIVE_CI_TIMEOUT_MS ?? maxSuiteMs);
const suiteLimitMs = Number.isFinite(askedMs) && askedMs > 0 ? Math.min(askedMs, maxSuiteMs) : maxSuiteMs;
const API = { host: '127.0.0.1', port: 8086 }, WEB = { host: '127.0.0.1', port: 3036 };
const apiOrigin = `http://${API.host}:${API.port}`, webOrigin = `http://localhost:${WEB.port}`;

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (a loopback Postgres admin connection).');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('native-ci only runs against a loopback Postgres server.');

const log = (...parts) => console.log(`[native-ci ${new Date().toISOString()}]`, ...parts);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = file => access(file).then(() => true, () => false);
const portOpen = ({ host, port }) => new Promise(resolve => {
	const socket = connect({ host, port });
	socket.once('connect', () => { socket.destroy(); resolve(true); });
	socket.once('error', () => resolve(false));
	socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
});
async function until(what, test, limitMs, child) {
	const deadline = Date.now() + limitMs;
	while (Date.now() < deadline) {
		if (child && ended(child)) throw new Error(`${what}: process ended early (${child.spawnError?.message ?? child.signalCode ?? child.exitCode})`);
		if (await test()) return;
		await sleep(500);
	}
	throw new Error(`${what}: not ready after ${Math.round(limitMs / 1000)} s`);
}

/** Known secrets (the fixture's session tokens, once read) plus every code/token shape the flow can produce. */
const secrets = new Set();
const redact = text => {
	let clean = text; for (const s of secrets) if (s) clean = clean.split(s).join('[redacted]');
	return clean
		.replace(/\b(?:nh|x|pks|pkr|sess|st|n|v)_[A-Za-z0-9_-]{16,}/g, '[redacted]')
		.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, '[redacted]')
		.replace(/\b(code|attempt|token|state|code_challenge|verifier)=[^&\s"'<>]+/g, '$1=[redacted]')
		.replace(/(captain_session=|Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted]');
};

const children = new Set();
function start(name, command, args, env, cwd = root) {
	const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	child.output = []; child.spawnError = null;
	const take = stream => stream?.on('data', chunk => { const text = chunk.toString(); child.output.push(text); process.stdout.write(redact(text).replace(/^/gm, `${name} | `)); });
	take(child.stdout); take(child.stderr);
	child.exited = new Promise(resolve => {
		child.once('exit', (code, signal) => { children.delete(child); resolve({ code, signal }); });
		child.once('error', error => { child.spawnError = error; child.output.push(`could not start: ${error.message}\n`); children.delete(child); resolve({ code: null, signal: null, error }); });
	});
	children.add(child);
	return child;
}
const ended = child => child.exitCode !== null || child.signalCode !== null || child.spawnError !== null;
function stop(child, graceMs = 30_000) {
	if (!child) return Promise.resolve(undefined);
	if (ended(child)) return child.exited;
	child.stopping ??= terminate(child, graceMs);
	return child.stopping;
}
async function terminate(child, graceMs) {
	try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
	const done = await Promise.race([child.exited, sleep(graceMs).then(() => null)]);
	if (done) return done;
	try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
	return child.exited;
}
let cancelled = false;
async function stopAll() { await Promise.all([...children].map(child => stop(child, 30_000))); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
	if (cancelled) return;
	cancelled = true;
	log(`received ${signal}; stopping children, then writing logs`);
	setTimeout(() => { log('cleanup did not finish in 120 s; exiting'); process.exit(130); }, 120_000).unref();
	void stopAll();
});

let web = null, fixture = null, check = null, passed = false, ready = false, cleaned = false;
const probe = await mkdtemp(path.join(tmpdir(), 'captain-native-ci-'));
try {
	await mkdir(out, { recursive: true });
	if (await portOpen(WEB) || await portOpen(API)) throw new Error('ports 3036 and 8086 must be free before native-ci starts');
	const nextCli = path.join(root, 'apps/web/node_modules/next/dist/bin/next');
	if (!(await exists(nextCli))) throw new Error(`Next CLI not found at ${path.relative(root, nextCli)}; run pnpm install first`);
	log('starting the production web server on 127.0.0.1:3036 (browser origin http://localhost:3036)');
	web = start('web', process.execPath, [nextCli, 'start', '--hostname', WEB.host, '--port', String(WEB.port)],
		{ ...process.env, API_URL: apiOrigin, APP_URL: webOrigin }, path.join(root, 'apps/web'));
	await until('web server', () => portOpen(WEB), 120_000, web);

	const env = { ...process.env, NATIVE_PROBE_DIR: probe, NATIVE_API_URL: apiOrigin, NATIVE_WEB_URL: webOrigin };
	log(`starting a fresh native fixture in ${probe}`);
	fixture = start('fixture', process.execPath, ['--import', 'tsx', 'test/native-fixture.ts'], (({ CHROME_CDP_URL, ...rest }) => rest)(env), path.join(root, 'apps/api'));
	await until('fixture', async () => await exists(path.join(probe, 'data.json')) && await portOpen(API)
		&& (await fetch(`${apiOrigin}/__fixture/ready`).then(r => r.ok, () => false)), 180_000, fixture);
	ready = true;
	const data = JSON.parse(await readFile(path.join(probe, 'data.json'), 'utf8'));
	for (const user of Object.values(data.users ?? {})) if (typeof user?.token === 'string') secrets.add(user.token);

	log(`running native-check.cjs (limit ${Math.round(suiteLimitMs / 60_000)} min)`);
	check = start('native-check', process.execPath, [path.join(root, 'apps/e2e/scripts/native-check.cjs')], env);
	const outcome = await Promise.race([check.exited, sleep(suiteLimitMs).then(() => null)]);
	if (!outcome) { log('time limit reached; stopping the check'); await stop(check, 10_000); }
	passed = !!outcome && outcome.code === 0;
	log(passed ? 'native sign-in proof passed' : 'native sign-in proof FAILED');
} catch (error) {
	log(error instanceof Error ? error.message : error);
} finally {
	if (check) await stop(check, 10_000);
	if (fixture) {
		const exit = await stop(fixture);
		cleaned = ready && !(await exists(path.join(probe, 'data.json')));
		log(`fixture exited (${exit?.error?.message ?? exit?.signal ?? exit?.code}); cleanup ${cleaned ? 'complete' : 'NOT confirmed (its database may remain on this runner)'}`);
	}
	await stop(web, 15_000);
	await mkdir(out, { recursive: true }).catch(() => undefined);
	for (const name of await readdir(probe).catch(() => [])) if (name.endsWith('.png')) await copyFile(path.join(probe, name), path.join(out, name)).catch(() => undefined);
	for (const [name, child] of [['web.log', web], ['fixture.log', fixture], ['native-check.log', check]]) if (child) await writeFile(path.join(out, name), redact(child.output.join(''))).catch(() => undefined);
	await rm(probe, { recursive: true, force: true });
	await stopAll();
}
if (cancelled) { log(`cancelled; logs so far are in ${path.relative(root, out)}`); process.exit(130); }
process.exit(passed && cleaned ? 0 : 1);
