import { randomUUID } from 'node:crypto';
import { withTenant } from '@captain/db';
import type { Harness } from '@captain/db/test';
import { BossEngine, Registry } from '@captain/engine';
import { definitions, retiredWorkflowVersions } from '@captain/steps';
import { installQueues } from '../../../packages/engine/src/queue.ts';
import { WorkflowService } from '../src/workflows/service.ts';
/** Business workflow fixture: no mail, personal calendar, outbox, or model/provider setup. */
export async function workflowFixture(db: Harness) {
 const [o] = await db.owner`insert into organisations (name) values ('Business workflow fixture') returning id`;
 const [u, member, stranger] = await db.owner`insert into users (email) values (${randomUUID() + '@example.test'}), (${randomUUID() + '@example.test'}), (${randomUUID() + '@example.test'}) returning id`;
 const org = String(o!.id), userId = String(u!.id), actor = { userId, requestId: randomUUID() };
 await db.owner`insert into memberships (organisation_id, user_id, role) values (${org}, ${userId}, 'owner'), (${org}, ${member!.id}, 'member')`;
 const tx = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, { organisationId: org, userId }, fn);
 const registry = new Registry(); await installQueues(db.databaseUrl, definitions);
 const url = new URL(db.databaseUrl); url.username = 'app'; url.password = 'app';
 const engine = new BossEngine(db.app, url.toString(), registry, definitions, 86400000, retiredWorkflowVersions);
 const workflows = new WorkflowService(db.app, null, engine); await workflows.sync(); await engine.open();
 return { org, userId, actor, member: { userId: String(member!.id), requestId: randomUUID() }, stranger: { userId: String(stranger!.id), requestId: randomUUID() }, tx, db, registry, engine, workflows };
}
export async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 15000): Promise<T> {
 const end = Date.now() + timeout; let value: T;
 do { value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
 throw Error('Timed out: ' + JSON.stringify(value));
}
