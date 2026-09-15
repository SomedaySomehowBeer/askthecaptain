import type { Harness } from '@captain/db/test';
import { briefFixture } from './brief-fixture.ts';
import { ChaseService } from '../src/chase/service.ts';
export async function chaseFixture(db: Harness) {
 const f = await briefFixture(db); let now = new Date();
 try {
  const chase = new ChaseService(db.app, () => now); chase.register(f.registry, f.inference, f.push);
  await f.engine.boss.updateQueue('workflow_chase-due', { retryDelay: 1, retryLimit: 1, retryBackoff: false });
  await f.tx(tx => tx`update users set name = 'Alex Captain' where id = ${f.userId}`);
  await f.tx(tx => tx`delete from outbox`);
  return { ...f, chase, setNow: (value: Date) => { now = value; },
   enable: () => f.workflows.enable(f.actor, f.org, 'chase-due', { enabled: true }),
   start: () => f.tx(tx => f.engine.start(tx, f.org, 'chase-due')),
   wake: (run: string, task: string) => f.tx(tx => f.engine.wake(tx, f.org, run, `task:${task}`)) };
 } catch (error) { await f.engine.close(); throw error; }
}
