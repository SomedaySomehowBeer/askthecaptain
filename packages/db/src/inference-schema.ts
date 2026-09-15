import { sql } from 'drizzle-orm';
import { bigint, check, customType, date, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organisations } from './connections-schema.ts';
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const memberships = pgTable('memberships', { organisationId: uuid('organisation_id').notNull(), userId: uuid('user_id').notNull() }, t => [primaryKey({ columns: [t.organisationId, t.userId] })]);
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const tenant = () => uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' });
const at = (name: string) => timestamp(name, { withTimezone: true });
export const inferenceRuntimes = pgTable('inference_runtimes', {
 id: id(), organisationId: tenant(), provider: text('provider', { enum: ['claude', 'codex', 'anthropic_api'] }).notNull(),
 spriteName: text('sprite_name'), region: text('region'), status: text('status', { enum: ['provisioning', 'needs_login', 'ready', 'failed', 'removed'] }).notNull(),
 loginHint: text('login_hint'), loginUrl: text('login_url'), addedBy: uuid('added_by').notNull(), connectionEncrypted: bytea('connection_encrypted'),
 lastVerifiedAt: at('last_verified_at'), error: text('error'), createdAt: at('created_at').notNull().defaultNow(), updatedAt: at('updated_at').notNull().defaultNow()
}, t => [unique().on(t.organisationId), unique().on(t.organisationId, t.id), foreignKey({ columns: [t.organisationId, t.addedBy], foreignColumns: [memberships.organisationId, memberships.userId] })]);
export const modelBudgets = pgTable('model_budgets', {
 id: id(), organisationId: tenant(), month: date('month').notNull(), limitTokens: bigint('limit_tokens', { mode: 'number' }).notNull(), costLimitMicros: bigint('cost_limit_micros', { mode: 'number' }), usedTokens: bigint('used_tokens', { mode: 'number' }).notNull().default(0)
}, t => [unique().on(t.organisationId, t.month), unique().on(t.organisationId, t.id), check('first_of_month', sql`extract(day from ${t.month}) = 1`), check('limit_tokens', sql`${t.limitTokens} between 0 and 9007199254740991`), check('used_tokens', sql`${t.usedTokens} between 0 and 9007199254740991`)]);
export const modelUsage = pgTable('model_usage', {
 id: id(), organisationId: tenant(), runId: uuid('run_id'), stepKey: text('step_key').notNull(), tier: text('tier', { enum: ['small', 'large'] }).notNull(),
 provider: text('provider', { enum: ['claude', 'codex'] }).notNull(), model: text('model').notNull(), inputTokens: bigint('input_tokens', { mode: 'number' }).notNull(), outputTokens: bigint('output_tokens', { mode: 'number' }).notNull(),
 costMicros: bigint('cost_micros', { mode: 'number' }), latencyMs: integer('latency_ms').notNull(), createdAt: at('created_at').notNull().defaultNow()
}, t => [unique().on(t.organisationId, t.id)]);
