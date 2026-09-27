import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** Source-level rules for docs/plans/expo-mobile-native-navigation-2026-09.md that a pure test cannot reach: the
 *  section stacks read one anchor constant, and every app-initiated tab entry goes through the one helper. Paths are
 *  relative to apps/mobile, where the test script runs. Comments are stripped before matching. */
const read = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const sourceFiles = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' })
	.filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)).map((file) => join(dir, file));

test('native navigation: the linking anchor and the navigator initial route are one constant, and views is declared', () => {
	const stack = read('src/components/SectionStack.tsx');
	assert.match(stack, /<Stack initialRouteName=\{sectionStackSettings\.initialRouteName\}/);
	assert.match(stack, /<Stack\.Screen name="index" \/>\s*<Stack\.Screen name="views" \/>/, 'index first, so it stays routeNames[0]; views declared');
	assert.match(stack, /export const anchored = sectionStackSettings\.initialRouteName !== undefined;/);
	for (const section of ['work', 'chat', 'resources']) {
		const layout = read(`src/app/(tabs)/${section}/_layout.tsx`);
		assert.match(layout, /export const unstable_settings = sectionStackSettings;/, section);
		assert.match(layout, /export default SectionStack;/, section);
	}
});

test('native navigation: every app-initiated tab entry goes through enterTabs; nothing else replaces into the tabs', () => {
	const offenders: string[] = [];
	for (const file of [...sourceFiles('src'), ...sourceFiles('harness')]) {
		const code = read(file);
		for (const match of code.matchAll(/router\.(replace|dismissTo)\(([^)]*)\)/g)) {
			const allowed = file.endsWith(join('account', 'tab-entry.ts'))
				|| (match[1] === 'replace' && match[2]!.trim() === "'/settings'" && file.endsWith(join('app', 'organisation.tsx')))
				|| (match[1] === 'dismissTo' && match[2]!.trim() === 'current.viewsHref' && file.endsWith(join('components', 'Screen.tsx')));
			if (!allowed) offenders.push(`${file}: ${match[0]}`);
		}
	}
	assert.deepEqual(offenders, []);
	const home = read('src/app/index.tsx');
	assert.match(home, /<Redirect href=\{href\} withAnchor=\{tabEntryAction\(anchored, \{ intent: 'arrive', href \}\)\.options\.withAnchor\} \/>/);
	const account = read('src/account/AccountStack.tsx');
	assert.match(account, /resetToFreshTabs\(target, anchored\)/);
	const refused = read('src/components/RefusedLink.tsx');
	assert.match(refused, /label: 'Go to My work', onPress: returnToMyWork/);
	assert.doesNotMatch(refused, /router\.back|canGoBack/, '"Go to My work" never goes back to whatever came before');
	assert.match(read('src/components/TabBar.tsx'), /navigation\.navigate\(route\.name, firstVisitParams\(anchored\)\)/);
});
