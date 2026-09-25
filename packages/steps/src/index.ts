import { chaseDue } from './defs/chase-due.ts';
import { stocktake } from './defs/stocktake.ts';
import type { WorkflowDefinition } from './definition.ts';

export * from './definition.ts';
export { catalog, requirementWords, type CatalogEntry, type Requirement } from './catalog.ts';
export { digestOf, requirementsOf, resolveParameters, validateDefinition, type Problem } from './validate.ts';

/** The catalogue of workflows the product offers (plan §6 "The first workflows"), in the order the
 *  Settings page lists them. Versioned with the code; the API syncs it into `workflow_definitions`. */
export const definitions: WorkflowDefinition[] = [chaseDue, stocktake];
export const definitionByKey = (key: string): WorkflowDefinition | undefined => definitions.find((d) => d.key === key);

/** Explicit retirement fences. Other versioned workflows retain immutable-run semantics. */
export const retiredWorkflowVersions: Readonly<Record<string, number>> = {
 'inbox-triage': Number.MAX_SAFE_INTEGER, 'discover-projects': Number.MAX_SAFE_INTEGER,
 'calendar-prep': Number.MAX_SAFE_INTEGER, 'morning-brief': Number.MAX_SAFE_INTEGER,
 'chase-due': 3, stocktake: 2
};
