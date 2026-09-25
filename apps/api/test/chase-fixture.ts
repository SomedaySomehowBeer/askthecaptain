import type { Harness } from '@captain/db/test';
import { workflowFixture } from './workflow-fixture.ts';
import { ChaseService } from '../src/chase/service.ts';
import { CommitmentsService } from '../src/commitments/service.ts';
import { PushService } from '../src/push/service.ts';
import { WorkflowService } from '../src/workflows/service.ts';
export async function chaseFixture(db: Harness) {
 const f = await workflowFixture(db); let now = new Date(); let failPush = false;
 const payloads: { endpoint: string; payload: any }[] = [];
 const push = new PushService(db.app, { send: async (device, payload) => { payloads.push({ endpoint: device.endpoint, payload: JSON.parse(payload) }); if (failPush) throw Error('Fixture push failed'); return { statusCode: 201 }; } }, 'fixture-key');
 await push.subscribe(f.actor, f.org, { endpoint: 'https://push.example.test/owner', keys: { p256dh: 'fixture', auth: 'fixture' } });
 const chase = new ChaseService(db.app, () => now); chase.register(f.registry, push);
 const workflows = new WorkflowService(db.app, push, f.engine);
 await f.engine.boss.updateQueue('workflow_chase-due', { retryDelay: 1, retryLimit: 1, retryBackoff: false });
 await f.tx(tx => tx`update organisations set timezone = 'Pacific/Kiritimati' where id = ${f.org}`);
 const commitments = new CommitmentsService(db.app), clock = await f.tx(tx => commitments.briefTasks(tx, f.org));
 const overdue = await commitments.createTask(f.actor, f.org, { title: 'File the return', due: '2020-01-01' });
 const due = await commitments.createTask(f.actor, f.org, { title: 'Pay the supplier', due: clock.today });
 return { ...f, chase, workflows, push, payloads, clock, overdue, due, setNow: (value: Date) => { now = value; }, failPush: (value: boolean) => { failPush = value; },
  enable: () => workflows.enable(f.actor, f.org, 'chase-due', { enabled: true }),
  start: () => f.tx(tx => f.engine.start(tx, f.org, 'chase-due')),
  wake: (run: string, task: string) => f.tx(tx => f.engine.wake(tx, f.org, run, `task:${task}`)) };
}
