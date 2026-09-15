import { GmailPush, startGmailPushSchedule } from './mail/push.ts';
import { GmailWatch } from './mail/watch.ts';
import { CalendarSync, startCalendarSchedule } from './calendar/sync.ts';
import { InferenceService } from './inference/service.ts';
import { MailSync, startMailSchedule } from './mail/sync.ts';
import { GoogleConnector } from '@captain/connectors';
import { ConnectionService } from './connections/service.ts';
import { masterKey } from './connections/encryption.ts';
import { serve } from '@hono/node-server';
import { connect } from '@captain/db';
import { createApp } from './app.ts';
import { GoogleIdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { SeriesRoutine, startSeriesSchedule } from './commitments/routine.ts';
import { CommitmentsService } from './commitments/service.ts';
import { readEnv } from './env.ts';
import { OrganisationService } from './organisations/service.ts';
import { PushService } from './push/service.ts';
import { webPushTransport } from './push/webpush.ts';
import { WorkflowService } from './workflows/service.ts';

const env = readEnv();
const db = connect(env.DATABASE_URL);
const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
	? new GoogleIdentityProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, new URL('/auth/google/callback', env.API_URL).toString())
	: null;
if (!google) console.warn('[api] Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
const connections = new ConnectionService(db, env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
	? new GoogleConnector(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, new URL('/connections/google/callback', env.API_URL).toString()) : null,
	env.MASTER_KEY ? masterKey(env.MASTER_KEY) : null, env.APP_URL);
const mailSync = new MailSync(db, connections);
const pushConfig = env.GMAIL_PUBSUB_TOPIC && env.GMAIL_PUSH_AUDIENCE ? { topic: env.GMAIL_PUBSUB_TOPIC, audience: env.GMAIL_PUSH_AUDIENCE } : undefined;
const gmailWatch = new GmailWatch(db, connections, pushConfig);
const gmailPush = pushConfig ? new GmailPush(db, mailSync, pushConfig) : undefined;
const stopGmailPush = startGmailPushSchedule(gmailPush, gmailWatch);
const stopMailSync = startMailSchedule(mailSync, env.MAIL_SYNC_DISABLED === '1');
const commitments = new CommitmentsService(db);
const stopSeries = startSeriesSchedule(new SeriesRoutine(db, commitments), env.SERIES_DISABLED === '1');
const calendarSync = new CalendarSync(db, connections);
const stopCalendarSync = startCalendarSchedule(calendarSync, env.CALENDAR_SYNC_DISABLED === '1');
const pushKeys = env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY && env.WEB_PUSH_SUBJECT ? { publicKey: env.WEB_PUSH_PUBLIC_KEY, privateKey: env.WEB_PUSH_PRIVATE_KEY, subject: env.WEB_PUSH_SUBJECT } : null;
if (!pushKeys) console.warn('[api] Web Push is not configured (WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY / WEB_PUSH_SUBJECT)');
const push = new PushService(db, pushKeys ? webPushTransport(pushKeys) : null, pushKeys?.publicKey ?? null);
const workflows = new WorkflowService(db, push);
// The catalogue is code; the table the API exposes follows it (plan §5 workflow_definitions).
await workflows.sync().catch((error) => console.error('[api] workflow catalogue sync failed', error instanceof Error ? error.message : error));
const app = createApp({ workflows, push, inference: new InferenceService(db, env.MASTER_KEY ? masterKey(env.MASTER_KEY) : null), db, gmailWatch, gmailPush, connections, calendarSync, calendarScheduleEnabled: env.CALENDAR_SYNC_DISABLED !== '1', mailSync, mailScheduleEnabled: env.MAIL_SYNC_DISABLED !== '1', auth: new AuthService(db, google, { appUrl: env.APP_URL, sessionTtlDays: env.SESSION_TTL_DAYS }), organisations: new OrganisationService(db), commitments });


const server = serve({ fetch: app.fetch, port: env.PORT }, () => console.log(`[api] listening on ${env.PORT}`));
const shutdown = () => { server.close(); void Promise.all([stopMailSync(), stopCalendarSync(), stopGmailPush(), stopSeries()]).then(() => db.end({ timeout: 5 })).then(() => process.exit(0)); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
