import { date, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, uuid, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organisations } from './connections-schema.ts';
import { workflowRuns } from './workflows-schema.ts';
export const briefs = pgTable('briefs', {
 organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
 runId: uuid('run_id').notNull(), forDate: date('for_date').notNull(), title: text('title').notNull(),
 lines: jsonb('lines').notNull(), items: jsonb('items').notNull(), producedAt: timestamp('produced_at', { withTimezone: true }).notNull().defaultNow()
}, t => [primaryKey({ columns: [t.organisationId, t.runId] }),
 foreignKey({ columns: [t.organisationId, t.runId], foreignColumns: [workflowRuns.organisationId, workflowRuns.id] }).onDelete('cascade'),
 index('briefs_latest').on(t.organisationId, t.forDate.desc(), t.producedAt.desc()),
 check('brief_title', sql`char_length(${t.title}) between 1 and 120`), check('brief_lines', sql`jsonb_typeof(${t.lines}) = 'array'`), check('brief_items', sql`jsonb_typeof(${t.items}) = 'array'`)]);
