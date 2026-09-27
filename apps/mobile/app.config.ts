/** The app configuration: `app.json` unchanged, except that the test-only account harness can be selected at build time
 *  (docs/plans/expo-mobile-auth-composition-2026-09.md §7.1).
 *
 *  - Only `CAPTAIN_MOBILE_HARNESS` exactly `1` selects it, by pointing the router root at `harness/app`. Any other
 *    value, or none, returns the configuration exactly as loaded from `app.json` (the default root `src/app`), so the
 *    production route context never contains a harness file.
 *  - Web export only. With the harness selected, a native build signal throws: `EAS_BUILD` set, or a native command or
 *    platform on the Expo CLI command line (`prebuild`, `run`, `run:ios`, `run:android`, `--platform ios|android|all`,
 *    or an `export` naming no platform, which exports every platform). This detection is best effort: it cannot see
 *    every way a native build could be started. The recorded evidence is the production iOS and Android exports built
 *    with the variable unset and their canary scans; actual native binaries remain a separate device/build gate.
 *  - The variable is not `EXPO_PUBLIC_`-prefixed, so it is never inlined into a bundle, and the boundary guard allows
 *    it (with `EAS_BUILD` and the command line) in this file only. It is never a runtime switch. */
import type { ConfigContext, ExpoConfig } from 'expo/config';

export const harnessRouterRoot = 'harness/app';

const nativeCommands = new Set(['prebuild', 'run', 'run:ios', 'run:android']);

/** The platforms named on an Expo CLI command line (`--platform x`, `--platform=x`, `-p x`). */
function namedPlatforms(argv: readonly string[]): string[] {
	const found: string[] = [];
	argv.forEach((arg, i) => {
		if (arg === '--platform' || arg === '-p') found.push(argv[i + 1] ?? '');
		else if (arg.startsWith('--platform=')) found.push(arg.slice('--platform='.length));
	});
	return found;
}

/** True when the command line or environment looks like a native build (best effort; see the header). */
export function nativeBuildSignal(signals: { easBuild: string | undefined; argv: readonly string[] }): boolean {
	if (signals.easBuild !== undefined && signals.easBuild !== '') return true;
	if (signals.argv.some((arg) => nativeCommands.has(arg))) return true;
	const platforms = namedPlatforms(signals.argv);
	if (platforms.some((platform) => platform !== 'web')) return true;
	return signals.argv.includes('export') && platforms.length === 0;
}

/** The configuration for the given signals. Pure, so node tests cover it. */
export function selectConfig(config: ConfigContext['config'], signals: { harness: string | undefined; easBuild: string | undefined; argv: readonly string[] }): ExpoConfig {
	if (signals.harness !== '1') return config as ExpoConfig;
	if (nativeBuildSignal(signals)) throw new Error('CAPTAIN_MOBILE_HARNESS is for the web harness export only; unset it for any native build or export');
	const extra = config.extra ?? {};
	const router = (extra.router ?? {}) as Record<string, unknown>;
	return { ...config, extra: { ...extra, router: { ...router, root: harnessRouterRoot } } } as ExpoConfig;
}

export default ({ config }: ConfigContext): ExpoConfig =>
	selectConfig(config, { harness: process.env.CAPTAIN_MOBILE_HARNESS, easBuild: process.env.EAS_BUILD, argv: process.argv });
