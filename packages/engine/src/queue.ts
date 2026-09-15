import { PgBoss, type Db } from 'pg-boss';
import type { TransactionSql } from '@captain/db';
import type { WorkflowDefinition } from '@captain/steps';
export const queueName = (key: string) => `workflow_${key}`;
export const schema = 'workflow_queue';
export const failedQueue = 'workflow_failed';
export const adapter = (tx: TransactionSql): Db => ({ executeSql: async (text, values) => ({ rows: await tx.unsafe(text, values as never[]) }) });
/** schedule()/unschedule() use the instance's DB (unlike send's per-call adapter). No start/DDL. */
export const transactionalBoss = (tx: TransactionSql) => new PgBoss({ db: adapter(tx), schema });
/** Safe on every release: pg-boss migrations and createQueue preserve existing queues, jobs and schedules; grants are repeatable. */
export async function installQueues(url: string, definitions: WorkflowDefinition[]) {
 const boss = new PgBoss({ connectionString: url, schema });
 boss.on('error', () => console.error('[workflows] queue setup failed'));
 try {
  await boss.start(); await boss.createQueue(failedQueue, { retryLimit: 10, retryDelay: 30 });
  for (const d of definitions) await boss.createQueue(queueName(d.key), { retryLimit: 3, retryDelay: 10, retryBackoff: true, expireInSeconds: 900, deadLetter: failedQueue });
  await boss.getDb().executeSql(`grant usage on schema ${schema} to app; grant select, insert, update, delete on all tables in schema ${schema} to app; grant usage on all sequences in schema ${schema} to app`);
 } finally { await boss.stop(); }
}
