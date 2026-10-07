/** Design tokens (plan D14). Authored here; the legacy CSS/design mirror was retired in R1c. Two palettes with the same
 *  keys, chosen by the device's colour scheme: the chat-first prototype's rules (docs/proposals/2026-09-29-chat-first-captain.md),
 *  not its pixels. The light palette is the reviewed R1b shell; the dark palette is the owner's reviewed dark set
 *  (validation: docs/validation/dark-theme-2026-10-02). Screens read a palette through `useTheme()` / `themedStyles()` in
 *  ./theme.ts, never a static colour. Type is the mockups' own: Fraunces for screen headings, card and group titles and
 *  sheet titles, Inter for everything else, vendored under apps/mobile/assets/fonts (SIL Open Font License 1.1) and
 *  loaded by ./fonts.ts (H1 fidelity: docs/validation/fidelity-2026-10-07). */
export type Palette = {
	readonly page: string; // the page background
	readonly card: string; // surfaces: rows, cards, buttons
	readonly heading: string; // strong text
	readonly body: string; // text
	readonly muted: string; // secondary text
	readonly action: string; // the one action colour; actionText on it
	readonly actionText: string;
	readonly line: string; // card borders
	/** A form control's or secondary button's border, a step stronger than `line` (R3 captain.css `.input`, `.btn`; the
	 *  prototype's `--line-strong`). */
	readonly fieldLine: string;
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
	/** R3 (design: captain-history-undo-2026-10-02): a warning note or state, its text and its border; a neutral state. */
	readonly warning: string;
	readonly warningText: string;
	readonly warningLine: string;
	readonly neutral: string;
	readonly neutralText: string;
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
	fieldLine: '#c6d2c1',
	rowLine: '#e6ece2',
	needsYou: '#e9f2e4',
	needsYouLine: '#bfd4b8',
	pinned: '#e3ebdd',
	sage: '#dbe6d4',
	sageText: '#2d4c36',
	plain: '#000000',
	unknown: 'rgba(84, 101, 90, 0.10)', // muted at 10%
	unknownStripe: 'rgba(84, 101, 90, 0.22)', // muted at 22%
	shadow: '#142619', // heading
	warning: '#fbe8c4',
	warningText: '#6b4a0c',
	warningLine: '#b98a2b',
	neutral: '#e4e8e1',
	neutralText: '#434a44'
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
	fieldLine: '#3a4a40',
	rowLine: '#263229',
	needsYou: '#1a2c21',
	needsYouLine: '#2f5040',
	pinned: '#1f3126',
	sage: '#2c4335',
	sageText: '#cfe3d1',
	plain: '#e6ede4', // body
	unknown: 'rgba(169, 182, 171, 0.10)', // muted at 10%
	unknownStripe: 'rgba(169, 182, 171, 0.22)', // muted at 22%
	shadow: '#000000',
	warning: '#3a2c10', // a dark amber surface; the light amber text on it
	warningText: '#f3d08a',
	warningLine: '#8a6a2a',
	neutral: '#2a312c',
	neutralText: '#cfd6d0'
};

/** The palette for a reported colour scheme. Anything but an explicit dark scheme (null, 'unspecified', 'light') is light. */
export function paletteFor(scheme: string | null | undefined): Palette {
	return scheme === 'dark' ? dark : light;
}

export function schemeOf(scheme: string | null | undefined): Scheme {
	return scheme === 'dark' ? 'dark' : 'light';
}

/** The type scale, measured from the reviewed mockups at 390 px (docs/validation/fidelity-2026-10-07). The thread list,
 *  new thread, equipment and team screens follow the chat-first prototype (docs/proposals/assets/captain-chat-first-
 *  2026-09-30, frames 1, 2, 5, 12, 15); a thread, its card and History follow the later R3 drawings of the same screens
 *  (captain-history-undo-2026-10-02/captain.css), which are drawn at a 15 px base. Sizes are points; each `…Line` is
 *  the line height. */
export const type = {
	heading: 22, headingLine: 28, // Fraunces 600: a screen heading (frames 1, 2, 5, 12 `.title`)
	pageHeading: 26, pageHeadingLine: 32, // Fraunces 600: History (R3 `.h1`)
	cardTitle: 19, cardTitleLine: 24, // Fraunces 600: a thread's record card (R3 `.card-title`)
	sheetTitle: 21, sheetTitleLine: 27, // Fraunces 600: the undo preview sheet (R3 `.sheet-title`)
	groupTitle: 15, groupTitleLine: 20, // Fraunces 600: a tag group in the thread list (frame 1 `.gname`)
	body: 15, bodyLine: 21, // Inter 400: messages, fields, notes (R3 `.screen`)
	rowTitle: 13, rowTitleLine: 17, // Inter 700: a thread row's or member's name (frame 1 `.row-title`, 650 drawn as 700)
	rowDetail: 11, rowDetailLine: 15, // Inter 600: a row's facts (frame 1 `.facts`)
	rowLast: 12, rowLastLine: 17, // Inter 400: a row's latest message (frame 1 `.last`)
	small: 13, smallLine: 18, // Inter 400: change lines, notes, help text (R3 `.change`, `.muted`, `.note`)
	label: 12, // Inter 400: a field's label (R3 `.field label`)
	meta: 12, // Inter 400: a message's time (R3 `.time`)
	tiny: 10, // Inter 400/700: a row's time, a group's metadata, a pip (frame 1 `.time`, `.gmeta`, `.count`)
	chip: 12, // Inter 600: a status or tag chip (R3 `.chip`)
	button: 15, // Inter 600: a button (R3 `.btn`)
	section: 11 // Inter 700, spaced capitals: a section label (frame 12 "PEOPLE", "AGENTS")
};

/** The vendored faces (apps/mobile/assets/fonts): the name each is registered under, and the fallback the web shows
 *  while it loads (`font-display: swap`). Every text style gets one through `themedStyles` (./theme.ts), by its weight:
 *  400 regular, 500 and 600 semibold, 700 and above bold; `display` is asked for by name. */
export const faces = { display: 'Fraunces-SemiBold', regular: 'Inter-Regular', semibold: 'Inter-SemiBold', bold: 'Inter-Bold' } as const;
export type Face = keyof typeof faces;
const fallback = { display: 'Georgia, "Times New Roman", serif', text: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' };

/** The face a text style draws with: `display` when it names Fraunces, otherwise Inter at the style's weight. */
export function faceFor(fontFamily: unknown, fontWeight: unknown): Face {
	if (fontFamily === faces.display) return 'display';
	const weight = fontWeight === 'bold' ? 700 : fontWeight === 'normal' || fontWeight === undefined ? 400 : Number(fontWeight);
	return weight >= 700 ? 'bold' : weight >= 500 ? 'semibold' : 'regular';
}

/** The CSS font family on the web (the face, then a system fallback while it loads); the registered name on iOS and Android. */
export function familyFor(face: Face, web: boolean): string {
	return web ? `"${faces[face]}", ${face === 'display' ? fallback.display : fallback.text}` : faces[face];
}

/** Every touch target is at least 44 pt; the page keeps a 16 pt gutter; content stays readable on a wide screen. */
export const space = { page: 16, rowMinHeight: 56, rowPadding: 12, minTarget: 44, maxContentWidth: 760 };
