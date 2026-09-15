import { calendarPrep } from './defs/calendar-prep.ts';
import { chaseDue } from './defs/chase-due.ts';
import { inboxTriage } from './defs/inbox-triage.ts';
import { morningBrief } from './defs/morning-brief.ts';
import { stocktake } from './defs/stocktake.ts';
import type { WorkflowDefinition } from './definition.ts';

export * from './definition.ts';
export { catalog, requirementWords, type CatalogEntry, type Requirement } from './catalog.ts';
export { digestOf, requirementsOf, resolveParameters, validateDefinition, type Problem } from './validate.ts';

/** The catalogue of workflows the product offers (plan §6 "The first workflows"), in the order the
 *  Settings page lists them. Versioned with the code; the API syncs it into `workflow_definitions`. */
export const definitions: WorkflowDefinition[] = [inboxTriage, morningBrief, chaseDue, calendarPrep, stocktake];
export const definitionByKey = (key: string): WorkflowDefinition | undefined => definitions.find((d) => d.key === key);

export { classifyThreadInstruction, draftReplyInstruction } from './instructions/inbox-triage.ts';

export { morningBriefInstruction } from './instructions/morning-brief.ts';
