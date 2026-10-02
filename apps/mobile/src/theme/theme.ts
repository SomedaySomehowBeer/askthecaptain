import { StyleSheet, useColorScheme } from 'react-native';
import { paletteFor, schemeOf, type Palette, type Scheme } from './tokens.ts';

/** The device's colour scheme and its palette. React Native's `useColorScheme` follows the iOS and Android appearance
 *  (app.json `userInterfaceStyle: automatic`) and, on the web, `prefers-color-scheme`, re-rendering when it changes. */
export function useTheme(): { readonly scheme: Scheme; readonly colors: Palette } {
	const scheme = schemeOf(useColorScheme());
	return { scheme, colors: paletteFor(scheme) };
}

/** A screen's styles built from the palette: `const useStyles = themedStyles((colors) => ({ … }))` at module scope, then
 *  `const styles = useStyles()` in each component. Each scheme's StyleSheet is created once and reused. */
export function themedStyles<T extends StyleSheet.NamedStyles<T>>(build: (colors: Palette) => T): () => T {
	const made: Partial<Record<Scheme, T>> = {};
	return function useStyles(): T {
		const { scheme, colors } = useTheme();
		return (made[scheme] ??= StyleSheet.create(build(colors)));
	};
}
