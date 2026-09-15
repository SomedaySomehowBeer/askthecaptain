import { sql } from 'drizzle-orm';
import { boolean, foreignKey, integer, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { connections, organisations } from './connections-schema.ts';
const base = () => ({ id: uuid('id').primaryKey().default(sql`uuidv7()`), organisationId: uuid('organisation_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }), connectionId: uuid('connection_id').notNull() });
const at = (name: string) => timestamp(name, { withTimezone: true });
export const shopifyProducts = pgTable('shopify_products', {
 ...base(), providerId: text('provider_id').notNull(), productProviderId: text('product_provider_id').notNull(), title: text('title').notNull(), variantTitle: text('variant_title').notNull(), sku: text('sku'),
 price: numeric('price').notNull(), productStatus: text('product_status').notNull(), inventoryItemId: text('inventory_item_id').notNull(), tracked: boolean('tracked').notNull(), seenRun: uuid('seen_run').notNull()
}, (t) => [unique().on(t.organisationId, t.connectionId, t.providerId), unique().on(t.organisationId, t.connectionId, t.inventoryItemId), foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade')]);
export const shopifyInventoryLevels = pgTable('shopify_inventory_levels', {
 ...base(), inventoryItemId: text('inventory_item_id').notNull(), locationProviderId: text('location_provider_id').notNull(), locationName: text('location_name').notNull(), available: integer('available').notNull(), updatedAt: at('updated_at').notNull(), seenRun: uuid('seen_run').notNull()
}, (t) => [unique().on(t.organisationId, t.connectionId, t.inventoryItemId, t.locationProviderId), foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade'), foreignKey({ columns: [t.organisationId, t.connectionId, t.inventoryItemId], foreignColumns: [shopifyProducts.organisationId, shopifyProducts.connectionId, shopifyProducts.inventoryItemId] }).onDelete('cascade')]);
export const shopifyOrders = pgTable('shopify_orders', {
 ...base(), providerId: text('provider_id').notNull(), number: text('number').notNull(), customerName: text('customer_name'), customerEmail: text('customer_email'), financialStatus: text('financial_status'), fulfilmentStatus: text('fulfilment_status').notNull(), cancelledAt: at('cancelled_at'), total: numeric('total').notNull(), currency: text('currency').notNull(), createdAt: at('created_at').notNull(), updatedAt: at('updated_at').notNull(), seenRun: uuid('seen_run')
}, (t) => [unique().on(t.organisationId, t.connectionId, t.providerId), foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade')]);
export const shopifyReorderPoints = pgTable('shopify_reorder_points', {
 ...base(), variantProviderId: text('variant_provider_id').notNull(), reorderPoint: numeric('reorder_point').notNull(), updatedAt: at('updated_at').notNull().defaultNow()
}, (t) => [unique().on(t.organisationId, t.connectionId, t.variantProviderId), foreignKey({ columns: [t.organisationId, t.connectionId], foreignColumns: [connections.organisationId, connections.id] }).onDelete('cascade'), foreignKey({ columns: [t.organisationId, t.connectionId, t.variantProviderId], foreignColumns: [shopifyProducts.organisationId, shopifyProducts.connectionId, shopifyProducts.providerId] }).onDelete('cascade')]);
