/** Manual, throwaway fixture for docs/investigations/11-pending.md. */
import { writeFile, unlink } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { freshDatabase } from '../../../packages/db/test/harness.ts';
import { triageFixture } from './triage-fixture.ts';
import { createApp } from '../src/app.ts';
import { AuthService } from '../src/auth/service.ts';
import { OrganisationService } from '../src/organisations/service.ts';
import { CommitmentsService } from '../src/commitments/service.ts';

const sessionPath = process.env.PROBE_SESSION_FILE;
if (!sessionPath) throw new Error('Set PROBE_SESSION_FILE to a new temporary file outside the repository.');
const db = await freshDatabase();
try {
  const fixture = await triageFixture(db);
  await fixture.engine.close();
  const commitments = new CommitmentsService(db.app);
  for (let i = 0; i < 70; i++) {
    await commitments.createTask(fixture.actor, fixture.org, {
      title: `Populated task ${i}`, due: '2020-01-01', status: i % 3 === 0 ? 'done' : 'open',
    });
  }
  for (let i = 0; i < 25; i++) {
    await commitments.createSeries(fixture.actor, fixture.org, {
      title: `Populated duty ${i}`, recurrence: 'monthly', anchor: '2026-01-01', dueOffsetDays: 21,
    });
  }
  const auth = new AuthService(db.app, null, { appUrl: 'http://127.0.0.1:3108', sessionTtlDays: 1 });
  const app = createApp({ db: db.app, auth, organisations: new OrganisationService(db.app), commitments });
  await writeFile(sessionPath, JSON.stringify({ token: (await auth.issueSessionFor(fixture.userId)).token }), { mode: 0o600, flag: 'wx' });
  const server = serve({ port: 8108, hostname: '127.0.0.1', fetch: app.fetch });
  console.log('Throwaway populated fixture listening on 127.0.0.1:8108. Stop with Ctrl-C.');
  async function stop() {
    server.close();
    await unlink(sessionPath!).catch(() => undefined);
    await db.close();
    process.exit(0);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  await db.close();
  throw error;
}
