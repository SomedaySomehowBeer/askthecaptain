import { randomUUID } from 'node:crypto';
import type { Harness } from '@captain/db/test';
import { briefFixture } from './brief-fixture.ts';
import { AnswerService } from '../src/answers/service.ts';
import { StockService } from '../src/stock/service.ts';
import { retrieve } from '../src/answers/retrieve.ts';
import { RateLimiter } from '../src/ratelimit.ts';
export async function answersFixture(db: Harness) {
 const f = await briefFixture(db);
 try {
 await f.tx(tx => tx`update users set name = 'Alex Captain' where id = ${f.userId}`);
 const [company] = await f.tx(tx => tx`insert into companies (organisation_id, name, domain) values (${f.org}, 'Supply Co', 'supply.test') returning id`);
 const [contact] = await f.tx(tx => tx`update contacts set name = 'Alex Supplier', role = 'Sales', source = 'hand', company_id = ${company!.id} where email = 'supplier@example.test' returning id`);
 await f.tx(tx => tx`update calendar_events set attendees = '[{"email":"supplier@example.test","name":"Alex Supplier","response":"accepted"}]' where id = ${f.eventId}`);
 await f.tx(tx => tx`insert into audit_events (organisation_id, actor_kind, action, subject_type, detail) values (${f.org}, 'system', 'mail.synced', 'connection', '{"success":true}')`);
 await f.tx(tx => tx`update xero_contacts set name = 'Supply Co', email = 'supplier@example.test', company_id = ${company!.id}, contact_id = ${contact!.id}`);
 const stock = new StockService(db.app); const item = await stock.save(f.actor, f.org, { name: 'Cans', location: 'Store', unitLabel: 'each', reorderPoint: '20' }); await stock.count(f.actor, f.org, item.id, { count: '12' });
 const [shop] = await f.tx(tx => tx`insert into connections (organisation_id, provider, connected_by, status, scopes, provider_account_id) values (${f.org}, 'shopify', ${f.userId}, 'connected', '{}', 'fixture.myshopify.com') returning id`);
 await f.tx(tx => tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${f.org}, ${shop!.id}, 'shopify.state', ${JSON.stringify({ complete: true, lastSyncedAt: new Date().toISOString(), error: null, coverageSince: null })})`);
 await f.tx(tx => tx`insert into shopify_products (organisation_id, connection_id, provider_id, product_provider_id, title, variant_title, sku, price, product_status, inventory_item_id, tracked, seen_run)
  values (${f.org}, ${shop!.id}, 'variant-one', 'product-one', 'Pale ale', 'Case', 'PALE', 72, 'ACTIVE', 'inventory-one', true, ${randomUUID()})`);
 await f.tx(tx => tx`insert into shopify_inventory_levels (organisation_id, connection_id, inventory_item_id, location_provider_id, location_name, available, updated_at, seen_run)
  values (${f.org}, ${shop!.id}, 'inventory-one', 'warehouse', 'Warehouse', 8, now(), ${randomUUID()})`);
 let rateClock = Date.now(); const limiter = new RateLimiter(() => rateClock);
 const answers = new AnswerService(db.app, f.inference, limiter);
 return { ...f, answers, limiter, companyId: String(company!.id), contactId: String(contact!.id), stockId: String(item.id), shopId: String(shop!.id),
  advanceRate: () => { rateClock += 3_600_001; }, retrieve: (question: string, now?: Date) => f.tx(tx => retrieve(db.app, tx, f.org, question, now)) };
 } catch (error) { await f.engine.close(); throw error; }
}
