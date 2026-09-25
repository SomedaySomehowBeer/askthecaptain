import { StockService } from '../src/stock/service.ts';
import { StocktakeService } from '../src/stock/workflow.ts';
import { PushService, type Payload } from '../src/push/service.ts';
import { WorkflowService } from '../src/workflows/service.ts';
import { workflowFixture } from './workflow-fixture.ts';
import type { Harness } from '@captain/db/test';
export async function stocktakeFixture(db: Harness) {
 const f = await workflowFixture(db); const pushes: Payload[] = [];
 const push = new PushService(db.app, { send: async (_device, payload) => { pushes.push(JSON.parse(payload)); return { statusCode: 201 }; } }, 'fixture-public');
 await push.subscribe(f.actor, f.org, { endpoint: `https://push.example.test/${f.org}`, keys: { p256dh: 'fixture', auth: 'fixture' } });
 const stocktake = new StocktakeService(db.app, push); stocktake.register(f.registry);
 const workflows = new WorkflowService(db.app, push, f.engine);
 const stock = new StockService(db.app, (tx, org, event, data, key) => f.engine.emit(tx, org, event, data, key));
 await workflows.enable(f.actor, f.org, 'stocktake', { enabled: true, parameters: { location: 'Store', purchasingProject: 'Purchasing' } });
 return { ...f, workflows, stocktake, stock, push, pushes, startStocktake: (location = 'Store') => workflows.control(f.actor, f.org, 'stocktake', 'run', { location }) };
}
