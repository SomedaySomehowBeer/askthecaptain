import { Hono } from 'hono';
import { z } from 'zod';
import type { Sql } from '@captain/db';
import type { Session } from '../auth/service.ts';
import { HttpError } from '../errors.ts';
import { roleOf } from '../tenant.ts';
export const legacyRetired = () => new HttpError(410, 'legacy_feature_retired', 'This personal-assistant feature has been retired from Captain. Use Work, Chat or Resources for shared business work.');
/** Authenticate and check tenant membership before acknowledging an old product route. */
export function retiredRoutes(db: Sql) {
 const routes = new Hono<{ Variables: { requestId: string; session: Session } }>();
 const roots = ['mail', 'calendar', 'outbox', 'notes', 'answers', 'briefs', 'discovery'];
 for (const path of [...roots.flatMap(root => [`/v1/organisations/:id/${root}`, `/v1/organisations/:id/${root}/*`]),
  '/v1/organisations/:id/projects/:projectId/accept', '/v1/organisations/:id/projects/:projectId/discard']) {
  routes.all(path, async c => { await roleOf(db, c.get('session').userId, z.uuid().parse(c.req.param('id'))); throw legacyRetired(); });
 }
 return routes;
}
