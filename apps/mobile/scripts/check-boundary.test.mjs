/** Tests for the client boundary guard. Each builds a synthetic apps/mobile in a temporary directory and injects one
 *  forbidden dependency, import, environment read, escape or bundle leak. Plain node:test, no dependencies. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkBundles, checkManifest, checkMobile, loadAllowlist, secretNames, stripComments } from './check-boundary.mjs';

const allowlist = await loadAllowlist();
const clean = {
	name: '@captain/mobile', private: true,
	dependencies: { expo: '~57.0.25', react: '19.2.3', 'react-native': '0.86.3', 'expo-router': '~57.0.23', 'expo-secure-store': '~57.0.4' },
	devDependencies: { typescript: '^5.9.0', '@types/react': '~19.2.0', '@types/node': '^22.0.0', tsx: '^4.23.0' }
};
/** A synthetic mobile root with the given manifest and files; removed afterwards. */
async function mobile(files, manifest = clean) {
	const outer = await mkdtemp(path.join(tmpdir(), 'captain-boundary-'));
	const root = path.join(outer, 'apps', 'mobile');
	await mkdir(root, { recursive: true });
	await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
	for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
	return { root, outer, done: () => rm(outer, { recursive: true, force: true }) };
}
const findingsFor = async (files, manifest) => { const m = await mobile(files, manifest); try { return await checkMobile(m.root, allowlist); } finally { await m.done(); } };
const has = (findings, pattern) => assert.ok(findings.some((f) => pattern.test(f)), `expected ${pattern} in ${JSON.stringify(findings)}`);

test('the checked-in allowlist names no @captain/* package and holds the contract’s runtime set', () => {
	for (const name of [...allowlist.dependencies, ...allowlist.devDependencies]) assert.ok(!name.startsWith('@captain/'), name);
	for (const name of ['expo', 'react', 'react-native', 'expo-router', 'expo-linking', 'expo-constants', 'react-native-screens', 'react-native-safe-area-context',
		'expo-dev-client', 'expo-web-browser', 'expo-secure-store', 'expo-crypto']) assert.ok(allowlist.dependencies.has(name), name);
	for (const name of ['@react-native-async-storage/async-storage', 'react-native-gesture-handler', 'react-native-reanimated', 'expo-notifications', '@sentry/react-native', '@simplewebauthn/browser', 'jest-expo'])
		assert.ok(!allowlist.dependencies.has(name) && !allowlist.devDependencies.has(name), `${name} is excluded by the contract`);
});

test('a clean manifest and app pass', async () => {
	const findings = await findingsFor({
		'app/_layout.tsx': "import { Stack } from 'expo-router';\nimport * as SecureStore from 'expo-secure-store';\nimport { tokens } from '../src/theme/tokens';\nexport default function Layout() { return null; }\n",
		'src/theme/tokens.ts': 'export const tokens = { forest: "#1f3d2b" };\n',
		'src/config.ts': 'export const apiUrl = process.env.EXPO_PUBLIC_API_URL;\nexport const appUrl = process.env.EXPO_PUBLIC_APP_URL;\n',
		'src/links.test.ts': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { tokens } from './theme/tokens';\n",
		'metro.config.js': "const path = require('node:path');\nconst { getDefaultConfig } = require('expo/metro-config');\nmodule.exports = getDefaultConfig(__dirname);\n",
		'scripts/anything.mjs': "import fs from 'node:fs'; process.env.DATABASE_URL;\n"
	});
	assert.deepEqual(findings, []);
});

test('the manifest refuses @captain/*, unlisted packages, non-registry specs and extra dependency fields', () => {
	const findings = checkManifest({
		dependencies: { ...clean.dependencies, '@captain/db': 'workspace:*', '@react-native-async-storage/async-storage': '2.0.0', 'expo-crypto': 'file:../x', 'expo-web-browser': 'github:someone/fork' },
		devDependencies: { ...clean.devDependencies, 'jest-expo': '57.0.0', expo: '~57.0.25' },
		peerDependencies: { react: '*' }
	}, allowlist);
	has(findings, /dependencies @captain\/db: @captain\/\* packages are never allowed/);
	has(findings, /dependencies @react-native-async-storage\/async-storage is not on the allowlist/);
	has(findings, /expo-crypto must be a registry version range/);
	has(findings, /expo-web-browser must be a registry version range/);
	has(findings, /devDependencies jest-expo is not on the allowlist/);
	has(findings, /devDependencies expo is not on the allowlist for devDependencies/);
	has(findings, /peerDependencies is not allowed/);
	for (const spec of ['workspace:^', 'npm:react@19', 'link:../x', 'git+https://example.test/x.git', 'https://example.test/x.tgz', './local', ''])
		assert.ok(checkManifest({ dependencies: { expo: spec } }, allowlist).some((f) => /registry version range/.test(f)), JSON.stringify(spec));
	for (const spec of ['57.0.25', '~57.0.23', '^19.2.3', '>=1.0.0 <2', '1.x', 'latest'])
		assert.deepEqual(checkManifest({ dependencies: { expo: spec } }, allowlist), [], spec);
});

test('app source may not import Node built-ins, @captain/*, undeclared packages, or paths outside apps/mobile', async () => {
	const findings = await findingsFor({
		'app/index.tsx': [
			"import fs from 'node:fs';", "import path from 'path';", "import { readFile } from 'fs/promises';",
			"import { db } from '@captain/db';", "export * from '@captain/steps';", "const api = require('@captain/api');",
			"import Storage from '@react-native-async-storage/async-storage';", "import Link from 'expo-linking';",
			"import { env } from '../../api/src/env';", "import secret from '/etc/passwd';",
			"const late = await import('../../../packages/model/src/index');", 'const name = "x"; const lazy = await import(name); const r = require(name);'
		].join('\n')
	});
	for (const pattern of [/node:fs is a Node built-in/, /: path is a Node built-in/, /fs\/promises is a Node built-in/, /@captain\/db is a @captain/, /@captain\/steps is a @captain/, /@captain\/api is a @captain/,
		/async-storage is not a declared, allowlisted runtime dependency/, /expo-linking is not a declared/, /\.\.\/\.\.\/api\/src\/env escapes apps\/mobile/, /\/etc\/passwd escapes/,
		/packages\/model\/src\/index escapes/, /dynamic import must name a literal module/, /require must name a literal module/]) has(findings, pattern);
});

test('a dev-only package is refused in app code but allowed in tests; tests and config still may not escape or use @captain/*', async () => {
	const findings = await findingsFor({
		'src/uses-dev.ts': "import { something } from 'tsx';\n",
		'src/ok.test.ts': "import { test } from 'node:test';\nimport 'tsx';\n",
		'src/bad.test.ts': "import { db } from '@captain/db';\nimport x from '../../web/src/lib/api';\n",
		'app.config.ts': "import path from 'node:path';\nimport { steps } from '@captain/steps';\n"
	});
	has(findings, /src\/uses-dev\.ts: tsx is not a declared, allowlisted runtime dependency/);
	assert.ok(!findings.some((f) => f.includes('ok.test.ts')), JSON.stringify(findings));
	has(findings, /bad\.test\.ts: @captain\/db is a @captain/);
	has(findings, /bad\.test\.ts: \.\.\/\.\.\/web\/src\/lib\/api escapes/);
	has(findings, /app\.config\.ts: @captain\/steps is a @captain/);
	assert.ok(!findings.some((f) => /app\.config\.ts: node:path/.test(f)), 'build config runs in Node');
});

test('only the two public variables may be read from the environment, anywhere outside scripts/', async () => {
	const findings = await findingsFor({
		'src/leak.ts': [
			'const a = process.env.DATABASE_URL;', "const b = process.env['MASTER_KEY'];", 'const { GOOGLE_CLIENT_SECRET } = process.env;',
			'const c = process.env?.SPRITES_API_TOKEN;', 'const d = import.meta.env.SECRET;', 'const ok = process.env.EXPO_PUBLIC_API_URL;',
			'// process.env.COMMENTED_OUT is not a read', '/* process.env.ALSO_COMMENTED */'
		].join('\n'),
		'app.config.ts': 'export default { extra: { key: process.env.MASTER_KEY, api: process.env.EXPO_PUBLIC_API_URL } };\n',
		'src/env.test.ts': 'process.env.NODE_ENV;\n'
	});
	has(findings, /leak\.ts: process\.env\.DATABASE_URL is not allowed/);
	has(findings, /leak\.ts: a computed, aliased or destructured use of process is not allowed/);
	has(findings, /leak\.ts: import\.meta\.env is not allowed/);
	has(findings, /app\.config\.ts: process\.env\.MASTER_KEY is not allowed/);
	has(findings, /env\.test\.ts: process\.env\.NODE_ENV is not allowed/);
	assert.ok(!findings.some((f) => /: process\.env\.EXPO_PUBLIC|COMMENTED/.test(f)), JSON.stringify(findings));
	assert.equal(findings.filter((f) => f.includes('leak.ts')).length, 5, 'two named secrets, two computed or destructured uses, one import.meta.env');
});

test('process cannot be reached through brackets, aliases, destructuring or globals; words in strings are not uses', async () => {
	const findings = await findingsFor({
		'src/bypass.ts': [
			'const a = process["env"].DATABASE_URL;', "const b = process['env']['MASTER_KEY'];", 'const p = process; const c = p.env.GOOGLE_CLIENT_SECRET;',
			'const { env } = process;', 'const d = globalThis.process.env.SPRITES_API_TOKEN;', 'const e = process?.env?.EXPO_PUBLIC_API_URL;'
		].join('\n'),
		'src/fine.ts': [
			'const text = "We process your stocktake overnight";', "const other = 'process.env.DATABASE_URL is only text here';",
			'const api = process.env.EXPO_PUBLIC_API_URL;', 'const note = `It’s ready: ${process.env.EXPO_PUBLIC_APP_URL}`;'
		].join('\n'),
		'src/template.ts': "const t = `Don't ship ${process.env.MASTER_KEY}`;\n"
	});
	const bypass = findings.filter((f) => f.includes('bypass.ts'));
	assert.equal(bypass.filter((f) => /a computed, aliased or destructured use of process/.test(f)).length, 4, JSON.stringify(bypass));
	has(bypass, /bypass\.ts: process\.env\.SPRITES_API_TOKEN is not allowed/);
	has(bypass, /bypass\.ts: process\.env\.EXPO_PUBLIC_API_URL is not allowed/); // optional chaining defeats Expo's public-variable inlining
	assert.ok(!findings.some((f) => f.includes('fine.ts')), JSON.stringify(findings));
	has(findings, /template\.ts: process\.env\.MASTER_KEY is not allowed/);
});

test('generated directories are skipped only at the mobile root; the same names deeper down are scanned; node_modules is skipped everywhere', async () => {
	const leak = 'const a = process.env.DATABASE_URL;\n';
	const findings = await findingsFor({
		'src/scripts/leak.ts': leak, 'src/dist/leak.ts': "import { db } from '@captain/db';\n", 'app/android/leak.tsx': leak, 'src/.hidden/leak.ts': leak,
		'scripts/tool.mjs': leak, 'dist/web/bundle.js': leak, '.expo/types/router.d.ts': leak, 'ios/Pods/x.js': leak,
		'node_modules/pkg/index.js': "import fs from 'node:fs';\n", 'src/node_modules/pkg/index.js': "import fs from 'node:fs';\n"
	});
	has(findings, /src\/scripts\/leak\.ts: process\.env\.DATABASE_URL/);
	has(findings, /src\/dist\/leak\.ts: @captain\/db is a @captain/);
	has(findings, /app\/android\/leak\.tsx: process\.env\.DATABASE_URL/);
	has(findings, /src\/\.hidden\/leak\.ts: process\.env\.DATABASE_URL/);
	for (const skipped of ['scripts/', 'dist/', '.expo/', 'ios/', 'node_modules/', 'src/node_modules/']) assert.ok(!findings.some((f) => f.startsWith(skipped)), `${skipped} is skipped: ${JSON.stringify(findings)}`);
	assert.equal(findings.length, 4, JSON.stringify(findings));
});

/** The two network files as the app has them: the binding and the forced options. */
const networkFiles = {
	'src/platform/fetch.ts': "import { fetch as expoFetch } from 'expo/fetch';\nimport { createNativeSend } from './native-send.ts';\nexport const nativeSend = createNativeSend(expoFetch);\n",
	'src/platform/native-send.ts': "export function createNativeSend(underlying) {\n\treturn (url, init) => underlying(url, { ...init, redirect: 'error', credentials: 'omit' });\n}\n",
	'src/api/client.ts': "// React Native's global fetch ignores redirect: 'error'; see src/platform/fetch.ts.\nexport function createTransport({ send }) { return (url) => send(url, { redirect: 'error' }); }\n"
};

test('network: the transport, its injected send and the one expo/fetch binding pass', async () => {
	assert.deepEqual(await findingsFor(networkFiles), []);
});

test('network: expo/fetch may be imported only by src/platform/fetch.ts, and that file must import it', async () => {
	const findings = await findingsFor({
		...networkFiles,
		'src/api/other.ts': "import { fetch } from 'expo/fetch';\n", 'src/lazy.ts': "const f = require('expo/fetch');\n",
		'src/deep.ts': "import { fetch } from 'expo/src/winter/fetch';\n", 'src/built.ts': "export * from 'expo/build/winter/fetch/index';\n",
		'src/platform/fetch.test.ts': "import { fetch } from 'expo/fetch';\n"
	});
	for (const file of ['src/api/other.ts', 'src/lazy.ts', 'src/deep.ts', 'src/built.ts']) has(findings, new RegExp(`${file.replace(/[./]/g, '\\$&')}: expo/\\S+ may be imported only by src/platform/fetch\\.ts`));
	assert.ok(!findings.some((f) => f.includes('fetch.test.ts')), 'tests are not app code');
	has(await findingsFor({ ...networkFiles, 'src/platform/fetch.ts': "export const nativeSend = globalThis.fetch;\n" }), /src\/platform\/fetch\.ts: must import expo\/fetch/);
});

test('network: the forced options are a tripwire in src/platform/native-send.ts', async () => {
	for (const text of ["export const s = (u, i) => f(u, { ...i, credentials: 'omit' });\n", "export const s = (u, i) => f(u, { ...i, redirect: 'error' });\n", '// redirect: \'error\', credentials: \'omit\' (only a comment)\nexport const s = f;\n'])
		has(await findingsFor({ ...networkFiles, 'src/platform/native-send.ts': text }), /native-send\.ts: must force redirect: 'error' and credentials: 'omit'/);
	assert.deepEqual(await findingsFor({ ...networkFiles, 'src/platform/native-send.ts': 'export const s = (u, i) => f(u, { ...i, redirect: "error", credentials: "omit" });\n' }), []);
});

test('network: no global fetch, other network entry point or synchronous random bytes anywhere in app source', async () => {
	const cases = {
		'src/a.ts': 'const r = await fetch("https://api.example.test/v1/me");\n',
		'src/b.ts': 'const r = await globalThis.fetch(url);\n', 'src/c.ts': 'const r = window.fetch(url);\n', 'src/d.ts': 'const f = global?.fetch;\n',
		'src/e.ts': "const r = self['fetch'](url);\n", 'src/f.ts': 'const r = globalThis["fetch"](url);\n',
		'src/g.ts': 'const x = new XMLHttpRequest();\n', 'src/h.ts': 'const s = new WebSocket(url);\n', 'src/i.ts': 'const e = new EventSource(url);\n',
		'src/j.ts': 'navigator.sendBeacon(url, body);\n', "src/k.ts": "import { Networking } from 'react-native';\n",
		'src/l.ts': "import { getRandomBytes } from 'expo-crypto';\nconst b = getRandomBytes(32);\n",
		'app/screen.tsx': 'export default function S() { void fetch(url); return null; }\n'
	};
	const findings = await findingsFor({ ...networkFiles, ...cases });
	for (const file of Object.keys(cases)) assert.ok(findings.some((f) => f.startsWith(`${file}: `)), `${file} is refused: ${JSON.stringify(findings)}`);
	has(findings, /src\/a\.ts: a call of fetch is not allowed/);
	has(findings, /src\/e\.ts: the global fetch is not allowed/);
	has(findings, /src\/l\.ts: expo-crypto's synchronous getRandomBytes is not allowed/);
});

test('network: names in comments and strings, methods of other objects and getRandomBytesAsync are not findings; tests may fake fetch', async () => {
	const findings = await findingsFor({
		...networkFiles,
		'src/fine.ts': [
			'// globalThis.fetch and XMLHttpRequest are never used here; WebSocket too.', '/* await fetch(url) */',
			'const label = "fetch(data) over WebSocket";', "const other = 'Networking';", 'const r = cache.fetch(key);', 'const b = await getRandomBytesAsync(32);',
			'const refetch = () => undefined; refetch();', 'const prefetch = true;'
		].join('\n'),
		'src/fake.test.ts': 'const fetch = async () => ({}); await fetch(url); globalThis.fetch = fetch;\n'
	});
	assert.deepEqual(findings, []);
});

test('comments are removed without disturbing strings', () => {
	assert.equal(stripComments("const u = 'http://x'; // note\nconst v = \"/* keep */\"; /* gone */"), "const u = 'http://x'; \nconst v = \"/* keep */\";  ");
	// An apostrophe in JSX text opens no string beyond its own line; a template literal may still span lines.
	assert.equal(stripComments("<Text>Captain can't reach it</Text>\n// process.env.DATABASE_URL\nconst t = `a\n// kept`;"), "<Text>Captain can't reach it</Text>\n\nconst t = `a\n// kept`;");
});

test('an apostrophe in JSX text does not turn a later comment into a finding', async () => {
	const findings = await findingsFor({
		'src/Copy.tsx': "export const Copy = () => <Text>Captain can't reach it</Text>;\n// process.env.DATABASE_URL was never read here\nexport const api = process.env.EXPO_PUBLIC_API_URL;\n"
	});
	assert.deepEqual(findings, []);
});

test('exported bundles are refused for server secret names, postgres URLs and canary values; public names and clean bundles pass', async () => {
	const outer = await mkdtemp(path.join(tmpdir(), 'captain-bundle-'));
	try {
		const names = await secretNames();
		for (const name of ['DATABASE_URL', 'MASTER_KEY', 'GOOGLE_CLIENT_SECRET', 'SPRITES_API_TOKEN', 'WEB_PUSH_PRIVATE_KEY']) assert.ok(names.includes(name), name);
		for (const name of ['API_URL', 'APP_URL', 'PORT', 'GOOGLE_CLIENT_ID']) assert.ok(!names.includes(name), `${name} is not a secret`);
		const cleanDir = path.join(outer, 'clean'); await mkdir(path.join(cleanDir, '_expo'), { recursive: true });
		await writeFile(path.join(cleanDir, '_expo', 'index.js'), 'var a="EXPO_PUBLIC_API_URL",b="https://api.example.invalid";');
		assert.deepEqual(await checkBundles([cleanDir], { names, canaries: ['canary-value-0001'] }), []);
		const leaky = path.join(outer, 'leaky'); await mkdir(path.join(leaky, 'ios'), { recursive: true });
		await writeFile(path.join(leaky, 'web.js'), 'var u="postgresql://captain@db.example/x",k=process.env.MASTER_KEY;');
		await writeFile(path.join(leaky, 'ios', 'index.hbc'), Buffer.concat([Buffer.from([0xc6, 0x1f, 0xbc, 0x03]), Buffer.from('DATABASE_URL\0canary-value-0001\0', 'latin1')]));
		const findings = await checkBundles([leaky], { names, canaries: ['canary-value-0001'] });
		has(findings, /web\.js: contains a postgres:\/\/ URL/);
		has(findings, /web\.js: contains the server secret name MASTER_KEY/);
		has(findings, /index\.hbc: contains the server secret name DATABASE_URL/);
		has(findings, /index\.hbc: contains canary value #1/);
		assert.ok(!findings.some((f) => f.includes('canary-value-0001') || f.includes('captain@db')), 'findings never quote what they found');
		has(await checkBundles([path.join(outer, 'missing')], { names }), /export directory not found/);
		const empty = path.join(outer, 'empty'); await mkdir(empty);
		has(await checkBundles([empty], { names }), /no exported files to scan/);
		// Regression: an empty platform export must fail even when another export directory has files.
		const mixed = await checkBundles([cleanDir, empty, path.join(outer, 'missing')], { names });
		assert.deepEqual(mixed.map((f) => f.replace(outer, '<outer>')), ['<outer>/empty: no exported files to scan', '<outer>/missing: export directory not found']);
	} finally { await rm(outer, { recursive: true, force: true }); }
});
