/** Client boundary guard for apps/mobile (mobile foundation contract §8, "CI guard"). Plain Node, no dependencies, so it
 *  runs before and after install. It is tooling only: nothing in the app imports it.
 *
 *    node apps/mobile/scripts/check-boundary.mjs                 manifest + source/config scan
 *    node apps/mobile/scripts/check-boundary.mjs <export-dir>…   the same, then scan production exported bundles
 *    node apps/mobile/scripts/check-boundary.mjs <export-dir>… --harness-export <dir>
 *                                                                 …and the test harness's web export
 *
 *  Manifest: every direct dependency is on the checked-in allowlist (client-boundary-allowlist.json), from the npm
 *  registry (no workspace:, file:, link:, git or URL specs), no @captain/* package ever, and no peer/optional/bundled
 *  dependency fields.
 *  Source: app code imports only relative paths inside apps/mobile or declared, allowlisted runtime packages; never
 *  node: or Node built-ins, never @captain/*, never a path escaping apps/mobile, never a non-literal import/require.
 *  Tests (*.test.*) and build config (app/metro/babel config) run in Node, so they may use node: built-ins and
 *  allowlisted dev packages, but the other rules hold. Everywhere, the only environment reads are
 *  process.env.EXPO_PUBLIC_API_URL and process.env.EXPO_PUBLIC_APP_URL, with one narrow allowance: the root
 *  app.config.* may also read process.env.CAPTAIN_MOBILE_HARNESS, process.env.EAS_BUILD and process.argv, to select the
 *  test-only account harness for the web export and refuse it for native builds (docs/plans/
 *  expo-mobile-auth-composition-2026-09.md §7.1). Nowhere else, including src/ and harness/, may read them.
 *  Harness variable (same plan): eas.json may never mention CAPTAIN_MOBILE_HARNESS. In the mobile package.json scripts
 *  and the repository's .github/workflows, a line that mentions it must either unset it (`env -u CAPTAIN_MOBILE_HARNESS`
 *  or `unset CAPTAIN_MOBILE_HARNESS`) or be a single command `CAPTAIN_MOBILE_HARNESS=1 … expo export --platform web …`
 *  naming no other platform. Any other form (a YAML env entry, `export`, $GITHUB_ENV) is a finding, because a
 *  lexical check cannot tell which steps it reaches. The setting and the export must be on one line (no `\`
 *  continuation); YAML comment lines are ignored. The harness marker (CAPTAIN_MOBILE_HARNESS_ followed by more
 *  characters) is a different name and is not matched.
 *  Network (app source only; docs/plans/expo-mobile-platform-account-2026-09.md): React Native's global fetch ignores
 *  `redirect: 'error'`, so app code reaches the network only through the API transport's injected `send`, which on
 *  device is `expo/fetch` bound in src/platform/fetch.ts. So: `expo/fetch` may be imported only by that file, and that
 *  file must import it; src/platform/native-send.ts must force `redirect: 'error'` and `credentials: 'omit'` (a
 *  tripwire; its node tests are the proof); and no app file may call a bare `fetch(`, name the global fetch
 *  (globalThis/global/window/self, dotted or bracketed), XMLHttpRequest, WebSocket, EventSource, sendBeacon or React
 *  Native's Networking, or use expo-crypto's synchronous getRandomBytes (it returns Math.random bytes in development).
 *  Bundles: no server secret variable name, no postgres:// URL, and no value named in BOUNDARY_CANARY_VALUES. Production
 *  exports also contain neither the harness marker nor a harness/app path; the harness export must contain the marker.
 *  Findings name the file and the rule, never surrounding content. Exit 1 on any finding.
 *
 *  Limits: the source scan is lexical, not a JavaScript/TypeScript parser. It recognises comments, quoted strings and
 *  template literals approximately, and finds imports and `process` uses with patterns. Known consequences:
 *  - an apostrophe or quote in JSX text is read as a string opening; it is closed at the end of that line, so it can
 *    hide (never invent) a `process` use or a comment on the rest of that one line;
 *  - a regular-expression literal containing quotes or `//` can be misread in the same bounded way;
 *  - template literal text is kept, so the word "process" in template text is reported (a false positive, never a miss);
 *  - an import or require spelled in a way the patterns do not recognise is not seen;
 *  - the network rules see names, not values: an alias (`const g = globalThis; g.fetch(…)`), a method call on some other
 *    object (`x.fetch(…)`) or a name built from strings is not seen, and a word such as `fetch(` in template text is
 *    reported (a false positive, never a miss).
 *  It is a boundary check that fails closed on common forms, backed by the exported-bundle scan, TypeScript and review;
 *  it is not proof that no other form exists. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultMobileRoot = path.resolve(here, '..');
export const allowedEnv = new Set(['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_APP_URL']);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
/** Generated trees and the guard itself, skipped only directly under the mobile root (with hidden root directories such
 *  as .expo). A directory of the same name deeper down, such as src/scripts, is ordinary source and is scanned.
 *  Installed packages (node_modules) are skipped at every depth. */
const rootSkippedDirectories = new Set(['dist', 'ios', 'android', 'web-build', 'coverage', 'scripts']);
/** Further export output directories at the mobile root, such as the harness export's dist-harness. */
const rootSkippedPrefix = /^dist-/;
const toolingConfig = /^(app|metro|babel)\.config\.(ts|js|mjs|cjs)$/;
const appConfig = /^app\.config\.(ts|js|mjs|cjs)$/;
/** Extra reads allowed in the root app.config.* only (see the header). */
const appConfigEnv = new Set(['CAPTAIN_MOBILE_HARNESS', 'EAS_BUILD']);
export const harnessVariable = 'CAPTAIN_MOBILE_HARNESS';
const builtins = new Set(builtinModules.flatMap((name) => [name, name.split('/')[0]]));
/** Server secrets that must never be in a bundle; the API's own environment schema adds any it defines later. */
const knownSecretNames = ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'MASTER_KEY', 'GOOGLE_CLIENT_SECRET', 'SHOPIFY_CLIENT_SECRET',
	'SPRITES_API_TOKEN', 'WEB_PUSH_PRIVATE_KEY', 'EMBED_TOKEN', 'FLY_API_TOKEN', 'NEON_API_KEY'];

export async function loadAllowlist(file = path.join(here, 'client-boundary-allowlist.json')) {
	const data = JSON.parse(await readFile(file, 'utf8'));
	const dependencies = new Set(Object.keys(data.dependencies ?? {}));
	const devDependencies = new Set(Object.keys(data.devDependencies ?? {}));
	for (const name of [...dependencies, ...devDependencies]) if (name.startsWith('@captain/')) throw new Error(`the allowlist may not name ${name}: @captain/* packages are refused`);
	return { dependencies, devDependencies };
}

/** Server secret names from the API's environment schema (keys that look like secrets), plus the known list. */
export async function secretNames(apiEnvFile = path.resolve(here, '../../api/src/env.ts')) {
	const names = new Set(knownSecretNames);
	const text = await readFile(apiEnvFile, 'utf8').catch(() => '');
	for (const [, name] of text.matchAll(/^\s*([A-Z][A-Z0-9_]{2,}):\s*z\./gm)) if (/SECRET|TOKEN|KEY|PASSWORD|DATABASE_URL/.test(name)) names.add(name);
	return [...names].sort();
}

const packageName = (specifier) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
/** A plain registry range or tag: no protocol (workspace:, npm: aliases, file:, link:, git…, URLs) and no path or
 *  owner/repo shorthand. */
const registrySpec = (spec) => typeof spec === 'string' && spec.trim() !== '' && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(spec)
	&& !spec.includes('/') && /^[\^~<>=*0-9A-Za-z.+\s|-]+$/.test(spec);

/** The manifest rules. Returns findings as strings. */
export function checkManifest(manifest, allowlist) {
	const findings = [];
	for (const field of ['peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies'])
		if (manifest[field] && Object.keys(manifest[field]).length) findings.push(`package.json: ${field} is not allowed in the client`);
	for (const [field, allowed] of [['dependencies', allowlist.dependencies], ['devDependencies', allowlist.devDependencies]]) {
		for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
			if (name.startsWith('@captain/')) { findings.push(`package.json: ${field} ${name}: @captain/* packages are never allowed in the client`); continue; }
			if (!allowed.has(name)) findings.push(`package.json: ${field} ${name} is not on the allowlist${allowlist.dependencies.has(name) || allowlist.devDependencies.has(name) ? ` for ${field}` : ''}`);
			if (!registrySpec(spec)) findings.push(`package.json: ${field} ${name} must be a registry version range, not a workspace, file, link, git or URL spec`);
		}
	}
	return findings;
}

/** Removes comments while keeping strings, so a commented-out import or env read is not a finding. A '…' or "…" string
 *  ends at a newline even without its closing quote: JavaScript strings cannot span lines, so an apostrophe in JSX text
 *  (<Text>can't</Text>) affects only the rest of its own line instead of swallowing later comments. */
export function stripComments(text) {
	let out = ''; let i = 0; let quote = null;
	while (i < text.length) {
		const c = text[i], n = text[i + 1];
		if (quote) {
			if (c === '\n' && quote !== '`') { quote = null; out += c; i++; continue; }
			out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === quote) quote = null; i++; continue;
		}
		if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
		if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
		if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; out += ' '; continue; }
		out += c; i++;
	}
	return out;
}

/** Replaces the contents of '…' and "…" strings with spaces (template literals are kept, so `${…}` expressions stay
 *  visible). Used only for identifier checks, never for import specifiers. */
export function blankQuotedStrings(code) {
	let out = ''; let quote = null; let template = false; let depth = 0;
	for (let i = 0; i < code.length; i++) {
		const c = code[i];
		if (quote) {
			if (c === '\\') { out += '  '; i++; continue; }
			if (c === quote || c === '\n') { quote = null; out += c; continue; }
			out += ' '; continue;
		}
		if (template && depth === 0) {
			// Template text is kept as written (its apostrophes are not quotes); `${` opens an expression.
			if (c === '\\') { out += c + (code[i + 1] ?? ''); i++; continue; }
			if (c === '`') { template = false; out += c; continue; }
			if (c === '$' && code[i + 1] === '{') { depth = 1; out += '${'; i++; continue; }
			out += c; continue;
		}
		if (template && c === '{') depth++;
		if (template && c === '}') { depth--; out += c; continue; }
		if (!template && c === '`') { template = true; out += c; continue; }
		if (c === '"' || c === "'") quote = c;
		out += c;
	}
	return out;
}

const importPatterns = [
	/\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]/g,
	/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s+['"]([^'"]+)['"]/g,
	/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
];

/** The source rules for one file. `kind` is 'app', 'test' or 'config'. */
export function checkSource({ file, text, kind, root, runtime, dev }) {
	const findings = []; const where = path.relative(root, file) || file;
	const code = stripComments(text);
	const specifiers = new Set();
	for (const pattern of importPatterns) for (const match of code.matchAll(pattern)) specifiers.add(match[1]);
	if (/\bimport\s*\(\s*(?!['"])/.test(code)) findings.push(`${where}: a dynamic import must name a literal module`);
	if (/\brequire\s*\(\s*(?!['"])/.test(code)) findings.push(`${where}: require must name a literal module`);
	for (const specifier of specifiers) {
		if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/') || specifier.startsWith('~/')) {
			const target = specifier.startsWith('@/') || specifier.startsWith('~/') ? path.resolve(root, specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
			if (specifier.startsWith('/') || (target !== root && !target.startsWith(root + path.sep))) findings.push(`${where}: ${specifier} escapes apps/mobile`);
			continue;
		}
		if (specifier.startsWith('node:') || builtins.has(specifier) || builtins.has(packageName(specifier))) {
			if (kind === 'app') findings.push(`${where}: ${specifier} is a Node built-in; the app bundle may not use it`);
			continue;
		}
		const name = packageName(specifier);
		if (name.startsWith('@captain/')) { findings.push(`${where}: ${specifier} is a @captain/* package; the client may not import it`); continue; }
		const allowed = kind === 'app' ? runtime : new Set([...runtime, ...dev]);
		if (!allowed.has(name)) findings.push(`${where}: ${specifier} is not a declared, allowlisted ${kind === 'app' ? 'runtime ' : ''}dependency`);
	}
	// Every use of `process` must be one of the two allowed reads. Quoted string contents are blanked first, so words in
	// text are not uses while process['env'], process["env"], aliases (const p = process) and destructuring still are.
	const identifiers = blankQuotedStrings(code);
	const isAppConfig = kind === 'config' && path.dirname(file) === root && appConfig.test(path.basename(file));
	for (const match of identifiers.matchAll(/\bprocess\b/g)) {
		const rest = identifiers.slice(match.index);
		const named = /^process\s*(?:\?\.|\.)\s*env\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/.exec(rest);
		if (named && allowedEnv.has(named[1]) && /^process\s*\.\s*env\s*\./.test(rest)) continue;
		if (isAppConfig && named && appConfigEnv.has(named[1]) && /^process\s*\.\s*env\s*\./.test(rest)) continue;
		if (isAppConfig && /^process\s*\.\s*argv\b/.test(rest)) continue;
		findings.push(`${where}: ${named ? `process.env.${named[1]}` : 'a computed, aliased or destructured use of process'} is not allowed; only process.env.${[...allowedEnv].join(' and process.env.')} may be read`);
	}
	if (/\bimport\s*\.\s*meta\s*\.\s*env\b/.test(code)) findings.push(`${where}: import.meta.env is not allowed; only ${[...allowedEnv].join(' and ')} may be read through process.env`);
	if (kind === 'app') findings.push(...checkNetwork({ where, code, identifiers, specifiers }));
	return findings;
}

/** The one file that binds `expo/fetch`, and the one that forces its options (see the header). */
export const nativeFetchFile = 'src/platform/fetch.ts';
export const forcedOptionsFile = 'src/platform/native-send.ts';
const expoFetchSpecifier = /^expo\/(?:fetch(?:\/|$)|src\/winter\/fetch|build\/winter\/fetch)/;
const networkNames = [
	[/\b(?:globalThis|global|window|self)\s*(?:\?\.|\.)\s*fetch\b/, 'the global fetch'],
	[/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
	[/\bWebSocket\b/, 'WebSocket'],
	[/\bEventSource\b/, 'EventSource'],
	[/\bsendBeacon\b/, 'sendBeacon'],
	[/\bNetworking\b/, "React Native's Networking module"]
];

/** The network rules for one app file. `identifiers` has quoted strings blanked; `code` keeps them (for the bracketed
 *  global and the forced-option tripwire). */
function checkNetwork({ where, code, identifiers, specifiers }) {
	const findings = []; const file = where.split(path.sep).join('/');
	const through = `requests go through the transport's send, bound to expo/fetch only in ${nativeFetchFile}`;
	for (const specifier of specifiers) if (expoFetchSpecifier.test(specifier) && file !== nativeFetchFile) findings.push(`${where}: ${specifier} may be imported only by ${nativeFetchFile}`);
	if (file === nativeFetchFile && !specifiers.has('expo/fetch')) findings.push(`${where}: must import expo/fetch`);
	for (const [pattern, what] of networkNames) if (pattern.test(identifiers)) findings.push(`${where}: ${what} is not allowed; ${through}`);
	if (/\b(?:globalThis|global|window|self)\s*(?:\?\.)?\s*\[\s*['"`]fetch['"`]\s*\]/.test(code)) findings.push(`${where}: the global fetch is not allowed; ${through}`);
	if (/(?<![\w$.])fetch\s*\(/.test(identifiers)) findings.push(`${where}: a call of fetch is not allowed; ${through}`);
	if (/\bgetRandomBytes\b/.test(identifiers)) findings.push(`${where}: expo-crypto's synchronous getRandomBytes is not allowed (it returns Math.random bytes in development); use getRandomBytesAsync`);
	if (file === forcedOptionsFile && !(/\bredirect\s*:\s*['"]error['"]/.test(code) && /\bcredentials\s*:\s*['"]omit['"]/.test(code)))
		findings.push(`${where}: must force redirect: 'error' and credentials: 'omit'`);
	return findings;
}

async function walk(directory, root, found = []) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue;
			if (directory === root && (rootSkippedDirectories.has(entry.name) || rootSkippedPrefix.test(entry.name) || entry.name.startsWith('.'))) continue;
			await walk(full, root, found);
		}
		else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name)) && !entry.name.endsWith('.d.ts')) found.push(full);
	}
	return found;
}
const kindOf = (root, file) => {
	const base = path.basename(file);
	if (/\.test\.[cm]?[jt]sx?$/.test(base)) return 'test';
	if (path.dirname(file) === root && toolingConfig.test(base)) return 'config';
	return 'app';
};

const mentionsHarness = new RegExp(`${harnessVariable}(?![A-Za-z0-9_])`);
/** One command line that mentions the harness variable: true only for the two permitted forms (see the header). */
export function harnessLineAllowed(line) {
	if (/(?:\benv\s+-u\s+|\bunset\s+)CAPTAIN_MOBILE_HARNESS(?![A-Za-z0-9_])/.test(line) && !/CAPTAIN_MOBILE_HARNESS\s*=/.test(line)) return true;
	const sets = line.match(/CAPTAIN_MOBILE_HARNESS(?![A-Za-z0-9_])/g) ?? [];
	if (sets.length !== 1 || !/(?:^|[\s;&|("'])CAPTAIN_MOBILE_HARNESS=1\s+(?:\S+\s+)*?\S*expo\s+export\b/.test(line)) return false;
	const platforms = [...line.matchAll(/(?:--platform(?:=|\s+)|\s-p\s+)(\S+)/g)].map((m) => m[1].replace(/["']/g, ''));
	return platforms.length > 0 && platforms.every((p) => p === 'web');
}

/** Where the harness variable may be set: never in eas.json; only the permitted lines in the mobile package.json
 *  scripts and the repository workflows. A missing eas.json or workflows directory has nothing to check. */
export async function checkHarnessSetters(root, workflowsDir = path.resolve(root, '..', '..', '.github', 'workflows')) {
	const findings = [];
	const easText = await readFile(path.join(root, 'eas.json'), 'utf8').catch(() => null);
	if (easText !== null && mentionsHarness.test(easText)) findings.push(`eas.json: ${harnessVariable} may never be set for an EAS build; the harness is for the web export only`);
	const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
	for (const [name, script] of Object.entries(manifest.scripts ?? {}))
		if (typeof script === 'string' && mentionsHarness.test(script) && !harnessLineAllowed(script))
			findings.push(`package.json: script ${name} may mention ${harnessVariable} only to unset it or as CAPTAIN_MOBILE_HARNESS=1 on an expo export --platform web command`);
	const workflows = await readdir(workflowsDir).catch(() => []);
	for (const name of workflows.filter((n) => /\.ya?ml$/.test(n)).sort()) {
		const lines = (await readFile(path.join(workflowsDir, name), 'utf8')).split('\n');
		lines.forEach((line, index) => {
			if (!mentionsHarness.test(line) || /^\s*#/.test(line)) return; // a YAML comment sets nothing
			const command = line.replace(/^\s*(?:-\s*)?(?:run:\s*)?/, '');
			if (!harnessLineAllowed(command)) findings.push(`.github/workflows/${name}:${index + 1}: ${harnessVariable} may be set only as CAPTAIN_MOBILE_HARNESS=1 on one expo export --platform web command, or unset`);
		});
	}
	return findings;
}

/** Manifest, harness-variable setters and every source file under the mobile root. */
export async function checkMobile(root = defaultMobileRoot, allowlist, options = {}) {
	allowlist ??= await loadAllowlist();
	const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
	const findings = checkManifest(manifest, allowlist);
	findings.push(...await checkHarnessSetters(root, options.workflowsDir));
	const declared = (field, allowed) => new Set(Object.keys(manifest[field] ?? {}).filter((name) => allowed.has(name)));
	const runtime = declared('dependencies', allowlist.dependencies), dev = declared('devDependencies', allowlist.devDependencies);
	for (const file of await walk(root, root)) findings.push(...checkSource({ file, text: await readFile(file, 'utf8'), kind: kindOf(root, file), root, runtime, dev }));
	return findings;
}

/** The fixed marker every harness layout renders (as a `testID`, so minification keeps it), and the harness router root
 *  (docs/plans/expo-mobile-auth-composition-2026-09.md §7.1). */
export const harnessMarker = 'CAPTAIN_MOBILE_HARNESS_7f3a';
export const harnessRootPath = 'harness/app';

/** Exported bundles: every file is read as bytes (Hermes bytecode keeps strings), and matched without context.
 *  `harness: 'absent'` (production exports, the default): no file may contain the harness marker or a harness/app path.
 *  `harness: 'present'` (the harness web export): each directory must contain the marker somewhere, proving the
 *  absence check can see it in minified output. The secret, postgres and canary rules apply to both. */
export async function checkBundles(directories, { names, canaries = [], harness = 'absent' }) {
	const findings = [];
	const withMarker = new Set();
	const nameMatchers = names.map((name) => [name, new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`)]);
	const files = [];
	const collect = async (directory, into) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) await collect(full, into); else if (entry.isFile()) into.push(full); } };
	// Each directory is judged on its own: one platform's missing or empty export is a finding even when another has files.
	const scanned = [];
	for (const directory of directories) {
		if (!(await stat(directory).then((s) => s.isDirectory(), () => false))) { findings.push(`${directory}: export directory not found`); continue; }
		const found = []; await collect(directory, found);
		if (found.length === 0) findings.push(`${directory}: no exported files to scan`);
		else scanned.push(directory);
		files.push(...found.map((file) => [directory, file]));
	}
	for (const [directory, file] of files) {
		const text = (await readFile(file)).toString('latin1');
		for (const [name, matcher] of nameMatchers) if (matcher.test(text)) findings.push(`${file}: contains the server secret name ${name}`);
		if (/postgres(?:ql)?:\/\//i.test(text)) findings.push(`${file}: contains a postgres:// URL`);
		for (const [index, canary] of canaries.entries()) if (canary && text.includes(canary)) findings.push(`${file}: contains canary value #${index + 1} from the export environment`);
		const marked = text.includes(harnessMarker);
		if (marked) withMarker.add(directory);
		if (harness === 'absent') {
			if (marked) findings.push(`${file}: contains the test harness marker; a production export must not include the harness`);
			if (text.includes(harnessRootPath)) findings.push(`${file}: contains a ${harnessRootPath} path; a production export must not include the harness`);
		}
	}
	if (harness === 'present') for (const directory of scanned) if (!withMarker.has(directory)) findings.push(`${directory}: the harness export does not contain the harness marker, so its absence elsewhere proves nothing`);
	return findings;
}

/** Command-line arguments: production export directories, and at most one `--harness-export <dir>`. */
export function parseBundleArguments(args) {
	const production = []; const harness = []; const errors = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--harness-export') {
			const next = args[i + 1];
			if (next === undefined || next.startsWith('--')) errors.push('--harness-export needs a directory'); else { harness.push(next); i++; }
		}
		else if (args[i].startsWith('--')) errors.push(`unknown option ${args[i]}`);
		else production.push(args[i]);
	}
	if (harness.length > 1) errors.push('--harness-export may be given once');
	return { production, harness, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { production, harness, errors } = parseBundleArguments(process.argv.slice(2));
	const exportDirectories = [...production, ...harness];
	const findings = [...errors];
	findings.push(...await checkMobile());
	if (exportDirectories.length) {
		const canaries = (process.env.BOUNDARY_CANARY_VALUES ?? '').split(',').map((v) => v.trim()).filter((v) => v.length >= 8);
		const names = await secretNames();
		if (production.length) findings.push(...await checkBundles(production.map((d) => path.resolve(d)), { names, canaries, harness: 'absent' }));
		if (harness.length) findings.push(...await checkBundles(harness.map((d) => path.resolve(d)), { names, canaries, harness: 'present' }));
	}
	for (const finding of findings) console.error(`boundary: ${finding}`);
	console.log(findings.length ? `boundary: ${findings.length} finding(s)` : `boundary: apps/mobile manifest and sources${exportDirectories.length ? ' and exported bundles' : ''} are within the client boundary`);
	process.exit(findings.length ? 1 : 0);
}
