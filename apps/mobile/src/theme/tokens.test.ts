import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dark, light, paletteFor, schemeOf, space, type, type Palette } from './tokens.ts';

/** WCAG 2.x relative luminance and contrast ratio (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio). */
type Rgba = { r: number; g: number; b: number; a: number };
const parse = (value: string): Rgba => {
	const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(value);
	if (hex) return { r: parseInt(hex[1]!, 16), g: parseInt(hex[2]!, 16), b: parseInt(hex[3]!, 16), a: 1 };
	const rgba = /^rgba\((\d+), (\d+), (\d+), (0?\.\d+|1|0)\)$/.exec(value);
	if (rgba) return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) };
	throw new Error(`not a colour: ${value}`);
};
/** A translucent colour painted over an opaque one. */
export const over = (top: string, under: string): string => {
	const t = parse(top), u = parse(under);
	const mix = (a: number, b: number) => Math.round(a * t.a + b * (1 - t.a)).toString(16).padStart(2, '0');
	return `#${mix(t.r, u.r)}${mix(t.g, u.g)}${mix(t.b, u.b)}`;
};
const luminance = (value: string) => {
	const { r, g, b, a } = parse(value);
	assert.equal(a, 1, `${value} must be opaque here; composite it first`);
	const channel = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
export const contrast = (fg: string, bg: string) => {
	const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
};

/** Every text or glyph colour on every surface the UI paints it on (grep the screens for the pair before adding one).
 *  Disabled controls (drawn at reduced opacity) are exempt under WCAG 1.4.3 and are not listed. */
export const textPairs = (p: Palette): readonly (readonly [string, string, string])[] => [
	['heading on page', p.heading, p.page], ['body on page', p.body, p.page], ['muted on page', p.muted, p.page],
	['plain on page', p.plain, p.page], ['action on page', p.action, p.page],
	['heading on card', p.heading, p.card], ['body on card', p.body, p.card], ['muted on card', p.muted, p.card],
	['plain on card', p.plain, p.card], ['action on card', p.action, p.card], ['sageText on card', p.sageText, p.card],
	['actionText on action', p.actionText, p.action],
	['sageText on sage', p.sageText, p.sage], ['heading on sage', p.heading, p.sage], ['muted on sage', p.muted, p.sage],
	['heading on needsYou', p.heading, p.needsYou], ['body on needsYou', p.body, p.needsYou], ['muted on needsYou', p.muted, p.needsYou],
	['sageText on needsYou', p.sageText, p.needsYou],
	['heading on pinned', p.heading, p.pinned], ['body on pinned', p.body, p.pinned],
	['card on sageText (pip)', p.card, p.sageText],
	['muted on unknown time', p.muted, over(p.unknown, p.page)]
];

test('the light palette is the reviewed green-grey set, unchanged, plus the tokens for colours the screens used inline', () => {
	assert.deepEqual(light, {
		page: '#f1f5ee', card: '#ffffff', heading: '#142619', body: '#1f3a2c', muted: '#54655a', action: '#276744', actionText: '#ffffff',
		line: '#d8e0d3', rowLine: '#e6ece2', needsYou: '#e9f2e4', needsYouLine: '#bfd4b8', pinned: '#e3ebdd', sage: '#dbe6d4', sageText: '#2d4c36',
		plain: '#000000', unknown: 'rgba(84, 101, 90, 0.10)', unknownStripe: 'rgba(84, 101, 90, 0.22)', shadow: '#142619'
	});
});

test('the dark palette is the owner-reviewed set', () => {
	assert.deepEqual(dark, {
		page: '#0f1a14', card: '#17231c', heading: '#f4f7f2', body: '#e6ede4', muted: '#a9b6ab', action: '#90e8a8', actionText: '#10261a',
		line: '#2e3d34', rowLine: '#263229', needsYou: '#1a2c21', needsYouLine: '#2f5040', pinned: '#1f3126', sage: '#2c4335', sageText: '#cfe3d1',
		plain: '#e6ede4', unknown: 'rgba(169, 182, 171, 0.10)', unknownStripe: 'rgba(169, 182, 171, 0.22)', shadow: '#000000'
	});
});

test('both palettes have the same keys, and every value is a plain hex colour or, for the translucent timeline tints, rgba', () => {
	assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
	for (const palette of [light, dark]) {
		for (const [key, value] of Object.entries(palette)) {
			if (key === 'unknown' || key === 'unknownStripe') assert.match(value, /^rgba\(\d+, \d+, \d+, 0\.\d+\)$/, key);
			else assert.match(value, /^#[0-9a-f]{6}$/, key);
		}
	}
});

test('the scheme picks the palette: only an explicit dark scheme is dark', () => {
	assert.equal(paletteFor('dark'), dark); assert.equal(schemeOf('dark'), 'dark');
	for (const scheme of ['light', null, undefined, 'unspecified', '']) {
		assert.equal(paletteFor(scheme), light, String(scheme)); assert.equal(schemeOf(scheme), 'light');
	}
});

for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
	test(`${name}: every text pair the UI paints is at least 4.5:1 (WCAG 2.x AA, normal text)`, () => {
		const failing = textPairs(palette).map(([pair, fg, bg]) => ({ pair, ratio: contrast(fg, bg) })).filter((p) => p.ratio < 4.5);
		assert.deepEqual(failing, []);
	});
}

test('unknown time on the equipment timeline stays distinct from free (page-colour) time, in dark at least as much as in light', () => {
	const distinct = (p: Palette) => {
		const base = over(p.unknown, p.page);
		return { base: contrast(base, p.page), stripe: contrast(over(p.unknownStripe, base), p.page) };
	};
	const l = distinct(light), d = distinct(dark);
	for (const [scheme, v] of [['light', l], ['dark', d]] as const) {
		assert.ok(v.base > 1.05, `${scheme} unknown base ${v.base}`);
		assert.ok(v.stripe > v.base, `${scheme} stripes are stronger than the base`);
	}
	assert.ok(d.base >= l.base && d.stripe >= l.stripe, `dark ${JSON.stringify(d)} vs light ${JSON.stringify(l)}`);
});

test('the contrast helper matches known WCAG values', () => {
	assert.equal(contrast('#000000', '#ffffff'), 21);
	assert.equal(contrast('#ffffff', '#ffffff'), 1);
	assert.equal(Math.round(contrast('#767676', '#ffffff') * 100) / 100, 4.54);
	assert.equal(over('rgba(0, 0, 0, 0.5)', '#ffffff'), '#808080');
});

test('headings are 26 pt, targets at least 44 pt, the gutter 16 pt, and wide screens keep a readable column', () => {
	assert.equal(type.heading, 26);
	assert.ok(space.minTarget >= 44);
	assert.equal(space.page, 16);
	assert.ok(space.maxContentWidth >= 600 && space.maxContentWidth <= 900);
});
