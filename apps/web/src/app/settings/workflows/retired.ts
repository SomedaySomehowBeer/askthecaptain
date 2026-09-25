/** Workflow versions retired with the personal-assistant product (#133), mirroring the engine's
 *  `retiredWorkflowVersions` fence in packages/steps: a run is retired when its version is at or
 *  below the fence. The four assistant workflows are retired at every version; chase-due up to v3
 *  and stocktake up to v2 are the old mail-drafting versions. Past runs stay readable and unfinished
 *  ones can still be cancelled, but the web never offers to turn on, run or resume a retired
 *  workflow. The API is the authority; this only keeps the page honest. */
const fences: Readonly<Record<string, number>> = {
	'inbox-triage': Number.MAX_SAFE_INTEGER, 'discover-projects': Number.MAX_SAFE_INTEGER,
	'calendar-prep': Number.MAX_SAFE_INTEGER, 'morning-brief': Number.MAX_SAFE_INTEGER,
	'chase-due': 3, stocktake: 2
};
/** Without a version, only a workflow retired at every version counts (the catalogue offers the current one). */
export function isRetiredWorkflow(key: string, version?: number): boolean {
	const fence = Object.hasOwn(fences, key) ? fences[key]! : undefined;
	if (fence === undefined) return false;
	if (version === undefined) return fence === Number.MAX_SAFE_INTEGER;
	return !Number.isInteger(version) || version <= fence;
}
