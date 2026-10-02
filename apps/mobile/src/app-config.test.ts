import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigContext } from 'expo/config';
import appJsonFile from '../app.json';
import { harnessRouterRoot, nativeBuildSignal, selectConfig } from '../app.config.ts';
import { dark, light } from './theme/tokens.ts';

type Loaded = ConfigContext['config'];
const appJson = appJsonFile as unknown as { expo: Loaded };
/** A fresh copy of what Expo loads from app.json. */
const loaded = (): Loaded => structuredClone(appJson.expo);
const webHarnessExport = ['node', 'expo', 'export', '--platform', 'web', '--output-dir', 'dist-harness'];
const productionExport = (platform: string) => ['node', 'expo', 'export', '--platform', platform, '--output-dir', `dist/${platform}`];

test('production: without exactly CAPTAIN_MOBILE_HARNESS=1 the configuration is app.json, unchanged and not copied', () => {
	for (const harness of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', '01', 'harness/app']) {
		for (const argv of [productionExport('web'), productionExport('ios'), productionExport('android'), ['node', 'expo', 'prebuild']]) {
			const config = loaded();
			const selected = selectConfig(config, { harness, easBuild: undefined, argv });
			assert.equal(selected, config, `${String(harness)} ${argv.join(' ')}`);
			assert.deepEqual(selected, appJson.expo);
			assert.equal(selected.extra?.router, undefined, 'the default router root (src/app) stays');
		}
		const onEas = loaded();
		assert.equal(selectConfig(onEas, { harness, easBuild: 'true', argv: ['node', 'eas-build'] }), onEas);
	}
});

test('the harness: CAPTAIN_MOBILE_HARNESS=1 on the web export points the router root at harness/app and changes nothing else', () => {
	const config = loaded();
	const selected = selectConfig(config, { harness: '1', easBuild: undefined, argv: webHarnessExport });
	assert.equal(harnessRouterRoot, 'harness/app');
	assert.deepEqual(selected, { ...appJson.expo, extra: { router: { root: 'harness/app' } } });
	assert.deepEqual(config, appJson.expo, 'the loaded configuration is not mutated');
	const withExtra = selectConfig({ ...loaded(), extra: { router: { origin: false }, other: 1 } }, { harness: '1', easBuild: undefined, argv: ['node', 'expo', 'export', '--platform=web'] });
	assert.deepEqual(withExtra.extra, { router: { origin: false, root: 'harness/app' }, other: 1 }, 'existing extra values are kept');
});

test('the harness refuses every native build signal it can see (best effort), and never falls back to a silent production config', () => {
	const refused: [string | undefined, string[]][] = [
		['true', webHarnessExport], ['1', webHarnessExport],
		[undefined, productionExport('ios')], [undefined, productionExport('android')], [undefined, ['node', 'expo', 'export', '--platform', 'all']],
		[undefined, ['node', 'expo', 'export', '-p', 'ios']], [undefined, ['node', 'expo', 'export', '--platform=android']],
		[undefined, ['node', 'expo', 'export', '--platform', 'web', '--platform', 'ios']], [undefined, ['node', 'expo', 'export']],
		[undefined, ['node', 'expo', 'prebuild']], [undefined, ['node', 'expo', 'run:ios']], [undefined, ['node', 'expo', 'run:android']], [undefined, ['node', 'expo', 'run']],
		[undefined, ['node', 'expo', 'export', '--platform']]
	];
	for (const [easBuild, argv] of refused) {
		assert.ok(nativeBuildSignal({ easBuild, argv }), `${String(easBuild)} ${argv.join(' ')}`);
		assert.throws(() => selectConfig(loaded(), { harness: '1', easBuild, argv }), /web harness export only/);
	}
	for (const argv of [webHarnessExport, ['node', 'expo', 'export', '--platform=web'], ['node', 'expo', 'start', '--web'], ['node', 'expo', 'config', '--type', 'introspect']])
		assert.equal(nativeBuildSignal({ easBuild: undefined, argv }), false, argv.join(' '));
	assert.equal(nativeBuildSignal({ easBuild: '', argv: webHarnessExport }), false, 'an empty EAS_BUILD is not set');
});

test('appearance: the app follows the device scheme; the native splash and Android icon background stay the light brand page colour', () => {
	const expo = appJson.expo;
	assert.equal(expo.userInterfaceStyle, 'automatic');
	// No dark splash or icon variant is configured (that needs the expo-splash-screen / expo-system-ui plugins, which the
	// plan does not name); the brand surfaces are the light page token.
	assert.equal((appJsonFile as { expo: { splash?: { backgroundColor?: string } } }).expo.splash?.backgroundColor, light.page);
	assert.equal(expo.android?.adaptiveIcon?.backgroundColor, light.page);
	assert.equal(expo.ios?.userInterfaceStyle, undefined, 'no per-platform override of the scheme');
	assert.equal(expo.android?.userInterfaceStyle, undefined, 'no per-platform override of the scheme');
});

test('the web shell paints the scheme page colour before React: one theme-color per scheme and a dark media query; the manifest stays light', async () => {
	const { readFile } = await import('node:fs/promises');
	const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
	assert.match(html, /<meta name="color-scheme" content="light dark" \/>/);
	assert.ok(html.includes(`<meta name="theme-color" media="(prefers-color-scheme: light)" content="${light.page}" />`));
	assert.ok(html.includes(`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${dark.page}" />`));
	assert.ok(html.includes(`html,body{height:100%;margin:0;background:${light.page}}`));
	assert.ok(html.includes(`@media (prefers-color-scheme:dark){html,body{background:${dark.page}}}`));
	const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8')) as Record<string, unknown>;
	assert.equal(manifest.background_color, light.page); assert.equal(manifest.theme_color, light.page);
});
