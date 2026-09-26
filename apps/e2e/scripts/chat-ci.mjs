/** CI runner for the linked-chat browser suites (chat-views-check.cjs, then chat-check.cjs). No dependencies.
 *
 *  Expects the production web build to exist already (built once, with API_URL=http://127.0.0.1:8084 and
 *  APP_URL=http://127.0.0.1:3034) and DATABASE_URL to name a loopback Postgres admin connection. Then:
 *  - starts `next start` once on 127.0.0.1:3034 and waits for it;
 *  - for each suite, in order: a new private probe directory, a fresh workspace fixture (its own disposable database,
 *    WORKSPACE_PROBE_FAST_LIMITS=1) on 127.0.0.1:8084, readiness, the suite with a time limit, then the fixture is
 *    terminated and its cleanup awaited (database dropped, data.json removed) before port 8084 is reused;
 *  - keeps only synthetic screenshots (*.png) and the logs, with the fixture's session tokens redacted, under
 *    CHAT_CI_OUT (default apps/e2e/chat-ci-output). data.json, the mode file and the probe directory never leave /tmp.
 *  Every child runs in its own process group and is stopped on exit, failure, timeout or signal.
 *  Exit code: 0 only when every suite passed. */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, copyFile, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.resolve(process.env.CHAT_CI_OUT ?? path.join(root, 'apps/e2e/chat-ci-output'));
/** Both suites by default (CI). For a focused local rerun, name suites as arguments, e.g.
 *  `node apps/e2e/scripts/chat-ci.mjs chat-check.cjs`; only these exact names, each at most once, run in the
 *  default order. Anything else is refused before any child starts. */
const allSuites = ['chat-views-check.cjs', 'chat-check.cjs'];
const asked = process.argv.slice(2);
const unknown = asked.filter(name => !allSuites.includes(name));
if (unknown.length) throw new Error(`Unknown suite(s): ${unknown.join(', ')}. Choose from: ${allSuites.join(', ')}.`);
if (new Set(asked).size !== asked.length) throw new Error(`A suite is named more than once: ${asked.join(', ')}.`);
const suites = asked.length ? allSuites.filter(name => asked.includes(name)) : allSuites;
/** Per-suite limit: 12 minutes by default and at most, so two suites plus setup fit the 40-minute CI job. */
const maxSuiteMs = 12 * 60_000;
const askedMs = Number(process.env.CHAT_CI_SUITE_TIMEOUT_MS ?? maxSuiteMs);
const suiteLimitMs = Number.isFinite(askedMs) && askedMs > 0 ? Math.min(askedMs, maxSuiteMs) : maxSuiteMs;
const API = { host: '127.0.0.1', port: 8084 }, WEB = { host: '127.0.0.1', port: 3034 };

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (a loopback Postgres admin connection).');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('chat-ci only runs against a loopback Postgres server.');

const log = (...parts) => console.log(`[chat-ci ${new Date().toISOString()}]`, ...parts);
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

/** Secrets to strip from anything written out: the fixture's session tokens, once known. */
const secrets = new Set();
const redact = text => { let clean = text; for (const s of secrets) if (s) clean = clean.split(s).join('[redacted]'); return clean.replace(/(captain_session=|Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted]'); };

const children = new Set();
/** Start a child directly (no package-manager wrapper, so the process waited on is the one doing the work) in its own
 *  process group. Output is kept in memory and mirrored, redacted, to the job log. `exited` resolves on exit and also
 *  when the process could not be started at all. */
function start(name, command, args, env, cwd = root) {
	const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	child.output = [];
	child.spawnError = null;
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
/** SIGTERM the whole group, wait, then SIGKILL; resolves once the child itself has exited. Stopping happens once per
 *  child: a second caller (cancellation during a suite's own cleanup) awaits the same stop instead of signalling the
 *  fixture again while it is dropping its database. */
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
/** Set only by SIGINT/SIGTERM. Normal cleanup also stops every child, but that is not a cancellation. */
let cancelled = false;
async function stopAll() { await Promise.all([...children].map(child => stop(child, 30_000))); }
// Cancellation: stop the children (the fixture still drops its database on SIGTERM), let the running suite's cleanup
// write its logs and screenshots, then exit 130. A hard limit keeps cancellation bounded if anything hangs.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
	if (cancelled) return;
	cancelled = true;
	log(`received ${signal}; stopping children, then writing logs`);
	setTimeout(() => { log('cleanup did not finish in 120 s; exiting'); process.exit(130); }, 120_000).unref();
	void stopAll();
});

/** One suite on one fresh fixture. Returns whether it passed; always tears the fixture down. */
async function runSuite(suite) {
	const probe = await mkdtemp(path.join(tmpdir(), 'captain-chat-ci-'));
	const target = path.join(out, suite.replace(/\.cjs$/, ''));
	await mkdir(target, { recursive: true });
	let fixture = null, browser = null, passed = false, cleaned = false, ready = false;
	try {
		await until('port 8084 free', async () => !(await portOpen(API)), 60_000);
		log(`${suite}: starting a fresh fixture in ${probe}`);
		const env = { ...process.env, WORKSPACE_PROBE_DIR: probe, WORKSPACE_PROBE_FAST_LIMITS: '1' };
		delete env.CHROME_CDP_URL;
		// Node itself runs the fixture (cwd apps/api, where `tsx` resolves), so stopping it waits for its own cleanup.
		fixture = start('fixture', process.execPath, ['--import', 'tsx', 'test/workspace-fixture.ts'], env, path.join(root, 'apps/api'));
		await until('fixture', async () => await exists(path.join(probe, 'data.json')) && await portOpen(API)
			&& (await fetch(`http://${API.host}:${API.port}/__fixture/stats`).then(r => r.ok, () => false)), 180_000, fixture);
		// Ready means its SIGTERM handler (drop database, remove data.json) is installed.
		ready = true;
		const data = JSON.parse(await readFile(path.join(probe, 'data.json'), 'utf8'));
		for (const key of ['token', 'memberToken']) if (typeof data[key] === 'string') secrets.add(data[key]);
		if (!(await portOpen(WEB))) throw new Error('web server on 3034 is not answering');

		log(`${suite}: running (limit ${Math.round(suiteLimitMs / 60_000)} min)`);
		browser = start(suite, process.execPath, [path.join(root, 'apps/e2e/scripts', suite)], env);
		const outcome = await Promise.race([browser.exited, sleep(suiteLimitMs).then(() => null)]);
		if (!outcome) { log(`${suite}: time limit reached; stopping it`); await stop(browser, 10_000); }
		passed = !!outcome && outcome.code === 0;
		log(`${suite}: ${passed ? 'passed' : 'FAILED'}`);
	} catch (error) {
		log(`${suite}: ${error instanceof Error ? error.message : error}`);
	} finally {
		if (browser) await stop(browser, 10_000);
		if (fixture) {
			// Waits for the fixture process itself. On SIGTERM it closes the server, drops its database, then removes
			// data.json and exits, so data.json gone after exit means that cleanup completed.
			// A fixture stopped before it was ready had no cleanup handler yet: its database may remain, so this is never
			// reported as clean.
			const exit = await stop(fixture);
			cleaned = ready && !(await exists(path.join(probe, 'data.json')));
			log(`fixture exited (${exit?.error?.message ?? exit?.signal ?? exit?.code}); cleanup ${cleaned ? 'complete' : ready ? 'NOT confirmed (its database may remain on this runner)' : 'NOT confirmed (stopped before it was ready; its database may remain on this runner)'}`);
		}
		// Keep only synthetic screenshots; data.json and the mode file stay in the private directory, which is removed.
		for (const name of await readdir(probe).catch(() => [])) if (name.endsWith('.png')) await copyFile(path.join(probe, name), path.join(target, name));
		for (const [name, child] of [['fixture.log', fixture], ['browser.log', browser]]) if (child) await writeFile(path.join(target, name), redact(child.output.join('')));
		await rm(probe, { recursive: true, force: true });
		await until('port 8084 released', async () => !(await portOpen(API)), 60_000).catch(error => log(error.message));
	}
	return passed && (fixture === null || cleaned);
}

let web = null, failed = 0;
try {
	await mkdir(out, { recursive: true });
	if (await portOpen(WEB) || await portOpen(API)) throw new Error('ports 3034 and 8084 must be free before chat-ci starts');
	log(`suites: ${suites.join(', ')}${asked.length ? ' (chosen on the command line)' : ''}`);
	log('starting the production web server on 127.0.0.1:3034');
	const nextCli = path.join(root, 'apps/web/node_modules/next/dist/bin/next');
	if (!(await exists(nextCli))) throw new Error(`Next CLI not found at ${path.relative(root, nextCli)}; run pnpm install first`);
	web = start('web', process.execPath, [nextCli, 'start', '--hostname', WEB.host, '--port', String(WEB.port)],
		{ ...process.env, API_URL: `http://${API.host}:${API.port}`, APP_URL: `http://${WEB.host}:${WEB.port}` }, path.join(root, 'apps/web'));
	await until('web server', () => portOpen(WEB), 120_000, web);
	for (const suite of suites) {
		if (cancelled) break;
		if (!(await runSuite(suite))) failed++;
	}
} catch (error) {
	log(error instanceof Error ? error.message : error);
	failed++;
} finally {
	await stop(web, 15_000);
	if (web) await writeFile(path.join(out, 'web.log'), redact(web.output.join(''))).catch(() => undefined);
	await stopAll();
}
if (cancelled) { log(`cancelled; logs and screenshots so far are in ${path.relative(root, out)}`); process.exit(130); }
log(failed ? `${failed} problem(s); see ${path.relative(root, out)}` : 'all chat suites passed');
process.exit(failed ? 1 : 0);
