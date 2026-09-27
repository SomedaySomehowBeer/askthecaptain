import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigContext } from 'expo/config';
import appJsonFile from '../app.json';
import { harnessRouterRoot, nativeBuildSignal, selectConfig } from '../app.config.ts';

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
