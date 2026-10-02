import postgres, { type Sql } from 'postgres';

export { withTenant, withUser, type TenantContext, type UserContext } from './context.ts';
export type { Sql, TransactionSql } from 'postgres';

/** One pool per process. Neon's pooler needs `prepare: false`; everything else is defaults. */
export function connect(url: string, options: { max?: number } = {}): Sql {
	const neonPooler = url.includes('-pooler') && url.includes('.neon.tech');
	return postgres(url, { max: options.max ?? 10, prepare: !neonPooler, idle_timeout: 20, connect_timeout: 10,
		transform: postgres.camel });
}
export { journalFields, journalledTables, openChangeSet, withChangeSet, journalled, fingerprintOf, changeSetIdFor, changesOf, ChangeSetUnavailable,
	type JournalledTable, type JournalRecordKind, type ChangeOperation, type ActorKind, type CauseKind, type RecordChange, type ChangeSetRequest,
	type OpenedChangeSet } from './versions.ts';
