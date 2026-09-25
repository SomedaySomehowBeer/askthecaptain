import { Hono } from 'hono';
import { z } from 'zod';
import type { Session } from '../auth/service.ts';
import type { CommitmentsService } from './service.ts';

type Vars = { Variables: { requestId: string; session: Session } };
// Lower-cased so a project or parent id compares equal to the stored one.
const uuid = z.string().uuid().transform((value) => value.toLowerCase());
/** Absent keeps the current project; null means no project. */
const projectRef = uuid.nullable().optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const status = z.enum(['suggested', 'open', 'in_progress', 'done', 'cancelled']);
const recurrence = z.enum(['monthly', 'quarterly', 'yearly', 'weekdays', 'custom']);
const text = (max: number) => z.string().trim().max(max);
const briefLine = z.object({ text: text(500).min(1), evidence: z.object({ kind: z.enum(['mail_thread', 'note']), id: uuid }).strict().nullable() }).strict();
const brief = z.object({ what: z.array(briefLine).max(30), standing: z.array(briefLine).max(30), people: z.array(briefLine).max(30), questions: z.array(briefLine).max(30) }).strict();

/** Commitments under an organisation. Mounted inside the signed-in router; the service checks the
 *  person's membership on every call. */
export function commitmentsRoutes(commitments: CommitmentsService) {
	const routes = new Hono<Vars>();
	const actor = (c: { get(key: 'session'): Session; get(key: 'requestId'): string }) => ({ userId: c.get('session').userId, requestId: c.get('requestId') });
	const org = (c: { req: { param(name: 'id'): string } }) => uuid.parse(c.req.param('id'));

	routes.get('/v1/organisations/:id/commitments', async (c) => c.json(await commitments.overview(actor(c), org(c))));

	routes.post('/v1/organisations/:id/projects', async (c) => {
		const input = z.object({ name: text(120).min(1), description: text(2000).optional(), stages: z.array(text(60)).max(20).optional(), ownerId: uuid.nullable().optional() }).parse(await c.req.json());
		return c.json(await commitments.createProject(actor(c), org(c), input), 201);
	});
	routes.patch('/v1/organisations/:id/projects/:projectId', async (c) => {
		const input = z.object({ name: text(120).min(1).optional(), description: text(2000).optional(), stages: z.array(text(60)).max(20).optional(), ownerId: uuid.nullable().optional(), archived: z.boolean().optional(),
			stage: z.enum(['idea', 'underway']).optional(), brief: brief.optional() }).parse(await c.req.json());
		return c.json(await commitments.updateProject(actor(c), org(c), uuid.parse(c.req.param('projectId')), input));
	});

	routes.post('/v1/organisations/:id/tasks', async (c) => {
		const input = z.object({ projectId: projectRef, parentId: uuid.optional(), title: text(200).min(1), body: text(5000).optional(), ownerId: uuid.nullable().optional(), due: date.nullable().optional(), status: status.optional() }).parse(await c.req.json());
		return c.json(await commitments.createTask(actor(c), org(c), input), 201);
	});
	routes.patch('/v1/organisations/:id/tasks/:taskId', async (c) => {
		const input = z.object({ projectId: projectRef, title: text(200).min(1).optional(), body: text(5000).optional(), ownerId: uuid.nullable().optional(), due: date.nullable().optional(), status: status.optional() }).parse(await c.req.json());
		return c.json(await commitments.updateTask(actor(c), org(c), uuid.parse(c.req.param('taskId')), input));
	});

	routes.post('/v1/organisations/:id/series', async (c) => {
		const input = z.object({ projectId: projectRef, title: text(200).min(1), body: text(5000).optional(), ownerId: uuid.nullable().optional(), evidenceRequired: z.boolean().optional(),
			recurrence, everyMonths: z.number().int().min(1).max(120).nullable().optional(), anchor: date, dueOffsetDays: z.number().int().min(-366).max(366).optional() }).parse(await c.req.json());
		return c.json(await commitments.createSeries(actor(c), org(c), input), 201);
	});
	routes.patch('/v1/organisations/:id/series/:seriesId', async (c) => {
		const input = z.object({ projectId: projectRef, title: text(200).min(1).optional(), body: text(5000).optional(), ownerId: uuid.nullable().optional(), evidenceRequired: z.boolean().optional(),
			recurrence: recurrence.optional(), everyMonths: z.number().int().min(1).max(120).nullable().optional(), anchor: date.optional(), dueOffsetDays: z.number().int().min(-366).max(366).optional(), paused: z.boolean().optional() }).parse(await c.req.json());
		return c.json(await commitments.updateSeries(actor(c), org(c), uuid.parse(c.req.param('seriesId')), input));
	});

	routes.post('/v1/organisations/:id/tasks/:taskId/evidence', async (c) => {
		const input = z.object({ kind: z.enum(['mail', 'file', 'url']), reference: text(2000).min(1), label: text(200).optional() }).parse(await c.req.json());
		return c.json(await commitments.addEvidence(actor(c), org(c), uuid.parse(c.req.param('taskId')), input), 201);
	});
	routes.delete('/v1/organisations/:id/evidence/:evidenceId', async (c) => {
		await commitments.removeEvidence(actor(c), org(c), uuid.parse(c.req.param('evidenceId'))); return c.json({ ok: true });
	});
	return routes;
}
