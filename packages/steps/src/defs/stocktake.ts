import { awaitStep, branch, defineWorkflow, each, infer, manual, notify, read, text, weekly, write } from '../definition.ts';

/** Plan §6 and D15: weekly or on demand, ask the counter for each item at the location and record
 *  the count; when a count is below the reorder point, raise a task in Purchasing and draft an
 *  order email to the preferred supplier. Connected commerce stock is read, not counted. */
export const stocktake = defineWorkflow({
	key: 'stocktake', version: 1, name: 'Stocktake', job: 4,
	description: 'Asks for a count of each stock item, records it, and raises an order when something is below its reorder point.',
	triggers: [weekly('mon', '08:00'), manual()],
	parameters: {
		location: text('The location to count.', { required: true, maxLength: 80 }),
		purchasingProject: text('The project reorder tasks go in.', { default: 'Purchasing', maxLength: 80 })
	},
	steps: [
		read('stock.items', { args: { location: { param: 'location' } }, as: 'items' }),
		each('items', [
			notify('push.counter', { args: { item: { ref: 'item' } } }),
			awaitStep('stock.counted', { args: { item: { ref: 'item' } }, timeoutDays: 3, as: 'count' }),
			write('stock.recordCount', { args: { item: { ref: 'item' }, count: { ref: 'count' } } }),
			branch({ truthy: 'count.belowReorderPoint' }, [
				write('tasks.createInProject', { args: { project: { param: 'purchasingProject' }, item: { ref: 'item' } } }),
				infer('draftOrderEmail', { schema: 'draft', tier: 'large', args: { item: { ref: 'item' }, count: { ref: 'count' } }, as: 'draft' }),
				write('outbox.create', { args: { supplier: { ref: 'item.preferredSupplier' }, draft: { ref: 'draft' } } })
			])
		]),
		read('shopify.stockLevels', { as: 'shopStock' }),
		each('shopStock', [
			branch({ truthy: 'item.belowReorderPoint' }, [
				write('tasks.createInProject', { args: { project: { param: 'purchasingProject' }, item: { ref: 'item' } } })
			])
		])
	]
});
