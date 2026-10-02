import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { badRequest } from '../errors.ts';
import { changeSetHeader } from '../changes.ts';
import { recordKind, VersionsService } from './service.ts';

type Vars = { Variables: { requestId: string; session: Session } };
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const revision = z.coerce.number().int().min(1).max(2_147_483_646);
function singleQuery(values: Record<string, string[]>): Record<string, string> {
	const query: Record<string, string> = {};
	for (const [key, entries] of Object.entries(values)) {
		if (entries.length !== 1) throw badRequest('invalid_request', 'Each query parameter must be supplied only once.');
		query[key] = entries[0]!;
	}
	return query;
}
async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
	try { return await req.json(); }
	catch (error) { if (error instanceof SyntaxError) throw badRequest('invalid_request', 'The request body must be valid JSON.'); throw error; }
}

/** History and reversal (versions contract §5). An unknown, foreign or hidden record or change is the generic 404. */
export function versionsRoutes(service: VersionsService) {
	const routes = new Hono<Vars>();
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
	const org = (c: { req: { param(name: 'id'): string } }) => uuid.parse(c.req.param('id'));
	const record = '/v1/organisations/:id/history/:recordKind/:recordId';
	const target = (c: { req: { param(name: 'recordKind' | 'recordId'): string } }) => [recordKind.parse(c.req.param('recordKind')), uuid.parse(c.req.param('recordId'))] as const;

	routes.get(record, async c => {
		const [kind, id] = target(c);
		return c.json(await service.history(actor(c), org(c), kind, id, singleQuery(c.req.queries())));
	});
	routes.get(`${record}/versions/:revision`, async c => {
		const [kind, id] = target(c);
		return c.json(await service.version(actor(c), org(c), kind, id, revision.parse(c.req.param('revision'))));
	});
	routes.post('/v1/organisations/:id/reversals/preview', async c => c.json(await service.preview(actor(c), org(c), await readJson(c.req))));
	routes.post('/v1/organisations/:id/reversals', async c => {
		const result = await service.apply(actor(c), org(c), await readJson(c.req));
		c.header(changeSetHeader, result.changeSet.id);
		return c.json(result, 201);
	});
	return routes;
}
