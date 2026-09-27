/** Client boundary guard for apps/mobile (mobile foundation contract §8, "CI guard"). Plain Node, no dependencies, so it
 *  runs before and after install. It is tooling only: nothing in the app imports it.
 *
 *    node apps/mobile/scripts/check-boundary.mjs                 manifest + source/config scan
 *    node apps/mobile/scripts/check-boundary.mjs <export-dir>…   the same, then scan exported bundles
 *
 *  Manifest: every direct dependency is on the checked-in allowlist (client-boundary-allowlist.json), from the npm
 *  registry (no workspace:, file:, link:, git or URL specs), no @captain/* package ever, and no peer/optional/bundled
 *  dependency fields.
 *  Source: app code imports only relative paths inside apps/mobile or declared, allowlisted runtime packages; never
 *  node: or Node built-ins, never @captain/*, never a path escaping apps/mobile, never a non-literal import/require.
 *  Tests (*.test.*) and build config (app/metro/babel config) run in Node, so they may use node: built-ins and
 *  allowlisted dev packages, but the other rules hold. Everywhere, the only environment reads are
 *  process.env.EXPO_PUBLIC_API_URL and process.env.EXPO_PUBLIC_APP_URL.
 *  Bundles: no server secret variable name, no postgres:// URL, and no value named in BOUNDARY_CANARY_VALUES.
 *  Findings name the file and the rule, never surrounding content. Exit 1 on any finding.
 *
 *  Limits: the source scan is lexical, not a JavaScript/TypeScript parser. It recognises comments, quoted strings and
 *  template literals approximately, and finds imports and `process` uses with patterns. Known consequences:
 *  - an apostrophe or quote in JSX text is read as a string opening; it is closed at the end of that line, so it can
 *    hide (never invent) a `process` use or a comment on the rest of that one line;
 *  - a regular-expression literal containing quotes or `//` can be misread in the same bounded way;
 *  - template literal text is kept, so the word "process" in template text is reported (a false positive, never a miss);
 *  - an import or require spelled in a way the patterns do not recognise is not seen.
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
const toolingConfig = /^(app|metro|babel)\.config\.(ts|js|mjs|cjs)$/;
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
	for (const match of identifiers.matchAll(/\bprocess\b/g)) {
		const rest = identifiers.slice(match.index);
		const named = /^process\s*(?:\?\.|\.)\s*env\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/.exec(rest);
		if (named && allowedEnv.has(named[1]) && /^process\s*\.\s*env\s*\./.test(rest)) continue;
		findings.push(`${where}: ${named ? `process.env.${named[1]}` : 'a computed, aliased or destructured use of process'} is not allowed; only process.env.${[...allowedEnv].join(' and process.env.')} may be read`);
	}
	if (/\bimport\s*\.\s*meta\s*\.\s*env\b/.test(code)) findings.push(`${where}: import.meta.env is not allowed; only ${[...allowedEnv].join(' and ')} may be read through process.env`);
	return findings;
}

async function walk(directory, root, found = []) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue;
			if (directory === root && (rootSkippedDirectories.has(entry.name) || entry.name.startsWith('.'))) continue;
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

/** Manifest and every source file under the mobile root. */
export async function checkMobile(root = defaultMobileRoot, allowlist) {
	allowlist ??= await loadAllowlist();
	const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
	const findings = checkManifest(manifest, allowlist);
	const declared = (field, allowed) => new Set(Object.keys(manifest[field] ?? {}).filter((name) => allowed.has(name)));
	const runtime = declared('dependencies', allowlist.dependencies), dev = declared('devDependencies', allowlist.devDependencies);
	for (const file of await walk(root, root)) findings.push(...checkSource({ file, text: await readFile(file, 'utf8'), kind: kindOf(root, file), root, runtime, dev }));
	return findings;
}

/** Exported bundles: every file is read as bytes (Hermes bytecode keeps strings), and matched without context. */
export async function checkBundles(directories, { names, canaries = [] }) {
	const findings = [];
	const nameMatchers = names.map((name) => [name, new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`)]);
	const files = [];
	const collect = async (directory, into) => { for (const entry of await readdir(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) await collect(full, into); else if (entry.isFile()) into.push(full); } };
	// Each directory is judged on its own: one platform's missing or empty export is a finding even when another has files.
	for (const directory of directories) {
		if (!(await stat(directory).then((s) => s.isDirectory(), () => false))) { findings.push(`${directory}: export directory not found`); continue; }
		const found = []; await collect(directory, found);
		if (found.length === 0) findings.push(`${directory}: no exported files to scan`);
		files.push(...found);
	}
	for (const file of files) {
		const text = (await readFile(file)).toString('latin1');
		for (const [name, matcher] of nameMatchers) if (matcher.test(text)) findings.push(`${file}: contains the server secret name ${name}`);
		if (/postgres(?:ql)?:\/\//i.test(text)) findings.push(`${file}: contains a postgres:// URL`);
		for (const [index, canary] of canaries.entries()) if (canary && text.includes(canary)) findings.push(`${file}: contains canary value #${index + 1} from the export environment`);
	}
	return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const exportDirectories = process.argv.slice(2).map((d) => path.resolve(d));
	const findings = await checkMobile();
	if (exportDirectories.length) {
		const canaries = (process.env.BOUNDARY_CANARY_VALUES ?? '').split(',').map((v) => v.trim()).filter((v) => v.length >= 8);
		findings.push(...await checkBundles(exportDirectories, { names: await secretNames(), canaries }));
	}
	for (const finding of findings) console.error(`boundary: ${finding}`);
	console.log(findings.length ? `boundary: ${findings.length} finding(s)` : `boundary: apps/mobile manifest and sources${exportDirectories.length ? ' and exported bundles' : ''} are within the client boundary`);
	process.exit(findings.length ? 1 : 0);
}
