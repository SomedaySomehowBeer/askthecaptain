import { Platform, StyleSheet, useColorScheme, type TextStyle } from 'react-native';
import { faceFor, familyFor, paletteFor, schemeOf, type Face, type Palette, type Scheme } from './tokens.ts';

/** The device's colour scheme and its palette. React Native's `useColorScheme` follows the iOS and Android appearance
 *  (app.json `userInterfaceStyle: automatic`) and, on the web, `prefers-color-scheme`, re-rendering when it changes. */
export function useTheme(): { readonly scheme: Scheme; readonly colors: Palette } {
	const scheme = schemeOf(useColorScheme());
	return { scheme, colors: paletteFor(scheme) };
}

const web = Platform.OS === 'web';

/** A text style's face: on the web the face's family with a system fallback while it loads, keeping the weight (the page
 *  turns off synthesised bold, public/index.html, so a semibold face is never thickened again); on iOS and Android the
 *  registered face alone, since each weight is its own file. */
export function face(name: Face): TextStyle {
	const fontWeight = name === 'bold' ? '700' : name === 'regular' ? '400' : '600';
	return web ? { fontFamily: familyFor(name, true), fontWeight } : { fontFamily: familyFor(name, false) };
}

/** Gives every text style (one with a font size, weight or line height, or that names Fraunces) its vendored face. */
export function withFaces<T extends Record<string, object>>(styles: T): T {
	const out: Record<string, object> = {};
	for (const [key, value] of Object.entries(styles)) {
		const style = value as TextStyle;
		const text = 'fontSize' in style || 'fontWeight' in style || 'lineHeight' in style || 'fontFamily' in style;
		if (!text) { out[key] = style; continue; }
		const { fontWeight, ...rest } = style;
		out[key] = { ...rest, ...face(faceFor(style.fontFamily, fontWeight)) };
	}
	return out as T;
}

/** A screen's styles built from the palette: `const useStyles = themedStyles((colors) => ({ … }))` at module scope, then
 *  `const styles = useStyles()` in each component. Each scheme's StyleSheet is created once and reused. Text styles get
 *  their face from `withFaces`. */
export function themedStyles<T extends StyleSheet.NamedStyles<T>>(build: (colors: Palette) => T): () => T {
	const made: Partial<Record<Scheme, T>> = {};
	return function useStyles(): T {
		const { scheme, colors } = useTheme();
		return (made[scheme] ??= StyleSheet.create(withFaces(build(colors))));
	};
}
