/** History and undo copy (design boards 5–11). */
export const historyCopy = {
	heading: 'History',
	sub: 'Newest first. Tick changes to undo them.',
	loading: 'Loading history…',
	failed: 'Could not load history. Check the connection and try again.',
	wait: 'Captain asked you to wait before loading history again.',
	empty: 'No changes yet.',
	earlier: 'Show earlier changes',
	loadingEarlier: 'Loading earlier changes…',
	unavailable: 'History is not available in this client yet.',
	previewing: 'Working out what the undo would do…',
	previewFailed: 'Could not preview the undo. Nothing was undone. Check the connection and try again.',
	previewWait: 'Captain asked you to wait before previewing again. Nothing was undone.',
	untouchedTail: 'This is added to History as a new change. Nothing is erased, and you can undo it too.',
	applying: 'Undoing…',
	uncertain: 'This undo may have been applied. Its change ID is kept: undo again with the same ID to confirm, or check History for it.',
	recovered: 'An undo you started may have been applied. Its change ID is kept: undo again with the same ID to confirm, check History for it, or forget it.',
	rate: 'Too many requests. Nothing was undone; wait before trying again.',
	idUnavailable: 'That change ID was already used for something else. Nothing was undone; preview again to start a new undo.',
	refused: 'Captain refused this undo. Nothing was undone. Preview it again.',
	forgotten: 'Forgotten. If that undo was applied, it is in History.',
	setYourself: (what: string) => `Set the ${what} yourself instead`,
	addCompanions: 'Also tick the rest of this change',
	needs: 'This was saved together with other changes, and they are undone together. Tick the rest of it to undo it.',
	schedule: 'Open the equipment schedule',
	versionLoading: 'Loading the record as it was…',
	versionFailed: 'Could not load that version. Check the connection and try again.',
	versionBack: 'Back to History',
	stateLabels: { 'Changed since': 'Changed since', Undone: 'Undone', 'Can’t undo': 'Can’t undo' }
} as const;
export const undone = (n: number) => `${n} change${n === 1 ? '' : 's'} undone.`;
export const ticked = (n: number) => `${n} change${n === 1 ? '' : 's'} ticked`;
export const undoLabel = (n: number) => `Undo ${n} change${n === 1 ? '' : 's'}`;
