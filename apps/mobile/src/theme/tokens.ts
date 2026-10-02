/** Design tokens (plan D14). Authored here; the legacy CSS/design mirror was retired in R1c. Two palettes with the same
 *  keys, chosen by the device's colour scheme: the chat-first prototype's rules (docs/proposals/2026-09-29-chat-first-captain.md),
 *  not its pixels. The light palette is the reviewed R1b shell; the dark palette is the owner's reviewed dark set
 *  (validation: docs/validation/dark-theme-2026-10-02). Screens read a palette through `useTheme()` / `themedStyles()` in
 *  ./theme.ts, never a static colour. Type uses the platform's system fonts: Fraunces and Inter are not bundled because no
 *  licensed font files are in this repository. */
export type Palette = {
	readonly page: string; // the page background
	readonly card: string; // surfaces: rows, cards, buttons
	readonly heading: string; // strong text
	readonly body: string; // text
	readonly muted: string; // secondary text
	readonly action: string; // the one action colour; actionText on it
	readonly actionText: string;
	readonly line: string; // card and control borders
	readonly rowLine: string; // lines between rows
	readonly needsYou: string; // prototype frame 1 row tint; keeps the sage icon tile distinct
	readonly needsYouLine: string;
	readonly pinned: string; // prototype frame 1 pinned-view surface
	readonly sage: string; // the selected row, filter or chip
	readonly sageText: string; // text on sage
	/** Text with no designed colour of its own (a fold chevron, a menu glyph, a plain status line): in light, the platform
	 *  default black it has always rendered; in dark, the body colour, so it never stays black on a dark page. */
	readonly plain: string;
	/** The equipment timeline's "not known" base tint and its stripes, translucent over the page. Free (fully read) time is
	 *  the opaque page colour, so unknown time must always look different from it. */
	readonly unknown: string;
	readonly unknownStripe: string;
	/** The drop shadow under a floating panel. */
	readonly shadow: string;
};

export type Scheme = 'light' | 'dark';

export const light: Palette = {
	page: '#f1f5ee', // the light green-grey background
	card: '#ffffff',
	heading: '#142619',
	body: '#1f3a2c',
	muted: '#54655a',
	action: '#276744', // white text on it
	actionText: '#ffffff',
	line: '#d8e0d3',
	rowLine: '#e6ece2',
	needsYou: '#e9f2e4',
	needsYouLine: '#bfd4b8',
	pinned: '#e3ebdd',
	sage: '#dbe6d4',
	sageText: '#2d4c36',
	plain: '#000000',
	unknown: 'rgba(84, 101, 90, 0.10)', // muted at 10%
	unknownStripe: 'rgba(84, 101, 90, 0.22)', // muted at 22%
	shadow: '#142619' // heading
};

export const dark: Palette = {
	page: '#0f1a14', // the dark green-black background
	card: '#17231c',
	heading: '#f4f7f2',
	body: '#e6ede4',
	muted: '#a9b6ab',
	action: '#90e8a8', // the light mint action; dark text on it
	actionText: '#10261a',
	line: '#2e3d34',
	rowLine: '#263229',
	needsYou: '#1a2c21',
	needsYouLine: '#2f5040',
	pinned: '#1f3126',
	sage: '#2c4335',
	sageText: '#cfe3d1',
	plain: '#e6ede4', // body
	unknown: 'rgba(169, 182, 171, 0.10)', // muted at 10%
	unknownStripe: 'rgba(169, 182, 171, 0.22)', // muted at 22%
	shadow: '#000000'
};

/** The palette for a reported colour scheme. Anything but an explicit dark scheme (null, 'unspecified', 'light') is light. */
export function paletteFor(scheme: string | null | undefined): Palette {
	return scheme === 'dark' ? dark : light;
}

export function schemeOf(scheme: string | null | undefined): Scheme {
	return scheme === 'dark' ? 'dark' : 'light';
}

export const type = {
	heading: 26, // screen headings
	body: 15,
	rowTitle: 15,
	rowDetail: 13,
	rowDetailLine: 18
};

/** Every touch target is at least 44 pt; the page keeps a 16 pt gutter; content stays readable on a wide screen. */
export const space = { page: 16, rowMinHeight: 56, rowPadding: 12, minTarget: 44, maxContentWidth: 760 };
