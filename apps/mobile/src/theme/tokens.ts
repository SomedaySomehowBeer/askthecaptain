/** Design tokens (plan D14). Authored here, outside the unedited legacy mirror in `packages/ui/design`. One palette for
 *  every platform: the chat-first prototype's rules (docs/proposals/2026-09-29-chat-first-captain.md), not its pixels.
 *  Light only until a dark palette is reviewed. Type uses the platform's system fonts: Fraunces and Inter are not
 *  bundled because no licensed font files are in this repository. */
export const colors = {
	page: '#f1f5ee', // the light green-grey background
	card: '#ffffff', // surfaces: rows, cards, buttons
	heading: '#142619', // strong text
	body: '#1f3a2c', // text
	muted: '#54655a', // secondary text
	action: '#276744', // the one action colour; white text on it
	actionText: '#ffffff',
	line: '#d8e0d3', // card and control borders
	rowLine: '#e6ece2', // lines between rows
	sage: '#dbe6d4', // the selected row, filter or chip
	sageText: '#2d4c36' // text on sage
} as const;

export const type = {
	heading: 26, // screen headings
	body: 15,
	rowTitle: 15,
	rowDetail: 13,
	rowDetailLine: 18
};

/** Every touch target is at least 44 pt; the page keeps a 16 pt gutter; content stays readable on a wide screen. */
export const space = { page: 16, rowMinHeight: 56, rowPadding: 12, minTarget: 44, maxContentWidth: 760 };
