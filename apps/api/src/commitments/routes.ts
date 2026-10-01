import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import { legacyRetired } from '../retirement/routes.ts';
import { roleOf } from '../tenant.ts';
import type { Sql } from '@captain/db';
import type { CommitmentsService } from './service.ts';

type Vars = { Variables: { requestId: string; session: Session } };
// Lower-cased so a parent or tag id compares equal to the stored one.
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
const tagIds = z.array(uuid).max(20);
const revision = z.number().int().min(1).max(2_147_483_647);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const status = z.enum(['suggested', 'open', 'in_progress', 'done', 'cancelled']);
const recurrence = z.enum(['monthly', 'quarterly', 'yearly', 'weekdays', 'custom']);
const text = (max: number) => z.string().trim().max(max);
const offset = z.coerce.number().int().min(0).max(1_000_000).default(0);
const limit = (max: number) => z.coerce.number().int().min(1).max(max).default(max);
const search = z.string().trim().max(100).optional().transform((value) => value || undefined);

/** Work records under an organisation. Mounted inside the signed-in router; the service checks the
 *  person's membership on every call. The legacy overview is retired, and so are the project routes: a project is a
 *  tag since 0046 (threads contract §5), and a task's tags are its thread's. */
export function commitmentsRoutes(commitments: CommitmentsService, db: Sql) {
	const routes = new Hono<Vars>();
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
	const org = (c: { req: { param(name: 'id'): string } }) => uuid.parse(c.req.param('id'));
	const query = <T extends z.ZodTypeAny>(schema: T, c: { req: { query(): Record<string, string> } }): z.infer<T> => schema.parse(c.req.query());

	routes.get('/v1/organisations/:id/commitments', async (c) => { await roleOf(db, c.get('session').userId, org(c)); throw legacyRetired(); });

	routes.get('/v1/organisations/:id/tasks/:taskId', async (c) => {
		const pages = query(z.object({ checklistOffset: offset, evidenceOffset: offset, tagOffset: offset, limit: limit(50) }).strict(), c);
		return c.json(await commitments.task(actor(c), org(c), uuid.parse(c.req.param('taskId')), pages));
	});
	routes.get('/v1/organisations/:id/series', async (c) => {
		const input = query(z.object({ tagId: uuid.optional(), paused: z.enum(['true', 'false']).optional().transform((v) => v === undefined ? undefined : v === 'true'), offset, limit: limit(50) }).strict(), c);
		return c.json(await commitments.seriesList(actor(c), org(c), input));
	});
	routes.get('/v1/organisations/:id/series/:seriesId', async (c) => c.json(await commitments.seriesDetail(actor(c), org(c), uuid.parse(c.req.param('seriesId')))));
	routes.get('/v1/organisations/:id/work/options', async (c) => {
		const input = query(z.object({ taskOffset: offset, limit: limit(100), q: search }).strict(), c);
		return c.json(await commitments.workOptions(actor(c), org(c), input));
	});

	routes.post('/v1/organisations/:id/tasks', async (c) => {
		const input = z.object({ parentId: uuid.optional(), expectedParentRevision: revision.optional(), title: text(200).min(1), body: text(5000).optional(), ownerId: uuid.nullable().optional(), due: date.nullable().optional(), status: status.optional() }).strict().parse(await c.req.json());
		return c.json(await commitments.createTask(actor(c), org(c), input), 201);
	});
	routes.patch('/v1/organisations/:id/tasks/:taskId', async (c) => {
		const input = z.object({ expectedRevision: revision, title: text(200).min(1).optional(), body: text(5000).optional(), ownerId: uuid.nullable().optional(), due: date.nullable().optional(), status: status.optional() }).strict().parse(await c.req.json());
		return c.json(await commitments.updateTask(actor(c), org(c), uuid.parse(c.req.param('taskId')), input));
	});

	routes.post('/v1/organisations/:id/series', async (c) => {
		const input = z.object({ tagIds: tagIds.optional(), title: text(200).min(1), body: text(5000).optional(), ownerId: uuid.nullable().optional(), evidenceRequired: z.boolean().optional(),
			recurrence, everyMonths: z.number().int().min(1).max(120).nullable().optional(), anchor: date, dueOffsetDays: z.number().int().min(-366).max(366).optional() }).strict().parse(await c.req.json());
		return c.json(await commitments.createSeries(actor(c), org(c), input), 201);
	});
	routes.patch('/v1/organisations/:id/series/:seriesId', async (c) => {
		const input = z.object({ expectedRevision: revision, tagIds: tagIds.optional(), title: text(200).min(1).optional(), body: text(5000).optional(), ownerId: uuid.nullable().optional(), evidenceRequired: z.boolean().optional(),
			recurrence: recurrence.optional(), everyMonths: z.number().int().min(1).max(120).nullable().optional(), anchor: date.optional(), dueOffsetDays: z.number().int().min(-366).max(366).optional(), paused: z.boolean().optional() }).strict().parse(await c.req.json());
		return c.json(await commitments.updateSeries(actor(c), org(c), uuid.parse(c.req.param('seriesId')), input));
	});

	routes.post('/v1/organisations/:id/tasks/:taskId/evidence', async (c) => {
		const input = z.object({ expectedRevision: revision, kind: z.enum(['mail', 'file', 'url']), reference: text(2000).min(1), label: text(200).optional() }).parse(await c.req.json());
		return c.json(await commitments.addEvidence(actor(c), org(c), uuid.parse(c.req.param('taskId')), input), 201);
	});
	routes.delete('/v1/organisations/:id/evidence/:evidenceId', async (c) => {
		const input = query(z.object({ expectedRevision: z.coerce.number().pipe(revision) }).strict(), c);
		await commitments.removeEvidence(actor(c), org(c), uuid.parse(c.req.param('evidenceId')), input); return c.json({ ok: true });
	});
	return routes;
}
