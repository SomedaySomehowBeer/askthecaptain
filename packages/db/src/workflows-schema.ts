import { sql } from 'drizzle-orm';
import { boolean, foreignKey, integer, smallint, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organisations } from './connections-schema.ts';
const users = pgTable('users', { id: uuid('id').primaryKey() });
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const org = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true });
export const workflowDefinitions = pgTable('workflow_definitions', {
 key: text('key').primaryKey(), version: integer('version').notNull(), name: text('name').notNull(), description: text('description').notNull(), job: smallint('job').notNull(),
 triggers: jsonb('triggers').notNull(), parameters: jsonb('parameters').notNull(), steps: jsonb('steps').notNull(), requirements: text('requirements').array().notNull().default(sql`'{}'`),
 digest: text('digest').notNull(), updatedAt: at('updated_at').notNull().defaultNow()
});
export const workflowEnablements = pgTable('workflow_enablements', {
 id: id(), organisationId: org(), definitionKey: text('definition_key').notNull().references(() => workflowDefinitions.key), definitionVersion: integer('definition_version').notNull(),
 enabled: boolean('enabled').notNull().default(false), enabledBy: uuid('enabled_by').references(() => users.id, { onDelete: 'set null' }), parameters: jsonb('parameters').notNull().default({}),
 scheduleOverrides: jsonb('schedule_overrides').notNull().default({}), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow()
}, t => [unique().on(t.organisationId, t.id), unique().on(t.organisationId, t.definitionKey)]);
export const workflowRuns = pgTable('workflow_runs', {
 id: id(), organisationId: org(), enablementId: uuid('enablement_id').notNull(), enabledBy: uuid('enabled_by').references(() => users.id, { onDelete: 'set null' }),
 definitionKey: text('definition_key').notNull(), definitionVersion: integer('definition_version').notNull(), definitionDigest: text('definition_digest').notNull(),
 trigger: jsonb('trigger').notNull(), snapshot: jsonb('snapshot'), scheduleKey: text('schedule_key'), scheduleAdvanced: boolean('schedule_advanced').notNull().default(false),
 state: text('state', { enum: ['queued', 'running', 'waiting', 'succeeded', 'failed', 'paused', 'cancelled'] }).notNull().default('queued'), reason: text('reason'),
 startedAt: at('started_at'), finishedAt: at('finished_at'), createdAt: at('created_at').notNull().defaultNow()
}, t => [unique().on(t.organisationId, t.id), foreignKey({ columns: [t.organisationId, t.enablementId], foreignColumns: [workflowEnablements.organisationId, workflowEnablements.id] }).onDelete('cascade')]);
export const workflowRunSteps = pgTable('workflow_run_steps', {
 id: id(), organisationId: org(), runId: uuid('run_id').notNull(), path: text('path').notNull(), itemIndex: integer('item_index'),
 kind: text('kind', { enum: ['read', 'infer', 'write', 'await', 'notify'] }).notNull(), key: text('key').notNull(),
 state: text('state', { enum: ['pending', 'running', 'waiting', 'succeeded', 'failed', 'skipped'] }).notNull().default('pending'),
 inputDigest: text('input_digest'), output: jsonb('output'), error: text('error'), deadline: at('deadline'), waitKey: text('wait_key'), startedAt: at('started_at'), finishedAt: at('finished_at')
}, t => [unique().on(t.organisationId, t.runId, t.path), foreignKey({ columns: [t.organisationId, t.runId], foreignColumns: [workflowRuns.organisationId, workflowRuns.id] }).onDelete('cascade')]);
