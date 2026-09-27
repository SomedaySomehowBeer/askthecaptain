/** Mobile design tokens (plan D14; contract §6). Authored here, outside the unedited legacy mirror in
 *  `packages/ui/design`; every value names its source. Light only until a dark palette is reviewed. Type uses the
 *  platform's system fonts: Fraunces and Inter are not bundled because no licensed font files are in this repository.
 *
 *  Sources:
 *  - [colors] packages/ui/design/tokens/colors.css
 *  - [nav] docs/proposals/assets/captain-mobile-2026-09-22/navigation.css (the approved floating tab bar and view rows)
 *  - [readme] docs/proposals/assets/captain-mobile-2026-09-22/README.md "Visual direction" */
export const colors = {
	page: '#f3ecdf', // [colors] --atc-cream, paper: the light background
	card: '#ffffff', // [colors] --atc-white
	heading: '#142619', // [colors] --atc-ink-900, forest deep
	body: '#1f3a2c', // [colors] --atc-ink-800, forest
	muted: '#5f6b62', // [colors] --atc-muted
	line: '#d9d0bf', // [colors] --atc-line
	mint: '#90e8a8', // [colors] --atc-mint
	sea: '#2f8a4a', // [colors] --atc-mint-text, accent text
	sage: '#c6dcc3', // [colors] --atc-mint-soft
	rowLine: '#ece6da', // [nav] .view-row border
	viewIcon: '#e9eee3', // [nav] .view-icon
	currentView: '#f0f5e9', // [nav] .current-view
	check: '#37714b', // [nav] .view-check
	barBackground: 'rgba(255, 253, 247, 0.93)', // [nav] #fffdf7ed
	barBorder: 'rgba(255, 255, 255, 0.8)', // [nav] #ffffffcc
	barShadow: '#142619', // [nav] shadow colour #142619 at low opacity
	barText: '#647367', // [nav] .bottom-nav a
	selectedPill: 'rgba(217, 222, 214, 0.5)', // [nav] .active: rgb(217 222 214 / 50%), the darker grey-green at 50%
	selectedText: '#197334' // [nav] .active colour: green icon and label
} as const;

export const tabBar = {
	widthShare: 0.8, // [nav] width: calc(80% - 22.4px)
	widthInset: 22.4, // [nav]
	height: 54, // [nav] [readme] about 290 × 54 on a 390 pt phone
	bottom: 19, // [nav] bottom: 19px, above the safe area
	padding: 3, // [nav]
	radius: 30, // [nav]
	icon: 22, // [nav] [readme] 22 pt icons
	label: 11, // [nav] [readme] 11 pt labels, always visible
	labelWeight: '600' as const, // [nav] 650, rounded to a weight every platform has
	minTarget: 44, // [nav] [readme] every tab target exceeds 44
	contentClearance: 98 // [nav] .content padding-bottom: 98px, so final controls clear the bar
};

/** The bar's width on a screen of this width: 80% less 22.4, about 290 on a 390 pt phone [nav], kept within reach
 *  on small phones and tablets. */
export const tabBarWidth = (screenWidth: number) => Math.min(360, Math.max(240, screenWidth * tabBar.widthShare - tabBar.widthInset));

export const type = {
	heading: 26, // [readme] screen headings are 26
	body: 15,
	rowTitle: 13, // [nav] .view-row strong
	rowDetail: 11, // [nav] .view-row small
	rowDetailLine: 16 // [nav]
};

export const space = { page: 16, rowMinHeight: 66, rowPadding: 12, viewIcon: 32, viewIconRadius: 11 }; // [nav] .view-row, .view-icon
