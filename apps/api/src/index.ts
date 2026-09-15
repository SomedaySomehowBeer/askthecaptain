import { ChaseService } from './chase/service.ts';
import { BriefService } from './briefs/service.ts';
import { StocktakeService } from './stock/workflow.ts';
import { StockService } from './stock/service.ts';
import { TriageService } from './triage/service.ts';
import { OutboxService } from './triage/outbox.ts';
import { startAttachmentExpiry } from './triage/expiry.ts';
import { ShopifyConnector } from '@captain/connectors/shopify';
import { ShopifyConnections } from './shopify/connections.ts';
import { ShopifySync, startShopifySchedule } from './shopify/sync.ts';
import { XeroConnector } from '@captain/connectors/xero';
import { XeroConnections } from './xero/connections.ts';
import { XeroSync, startXeroSchedule } from './xero/sync.ts';
import { BossEngine } from '@captain/engine';
import { definitions } from '@captain/steps';
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
import { PasskeyService } from './auth/passkeys.ts';
import { AuthService } from './auth/service.ts';
import { simpleWebAuthn } from './auth/webauthn.ts';
import { SeriesRoutine, startSeriesSchedule } from './commitments/routine.ts';
import { CommitmentsService } from './commitments/service.ts';
import { readEnv } from './env.ts';
import { OrganisationLifecycle } from './organisations/lifecycle.ts';
import { OrganisationService } from './organisations/service.ts';
import { PushService } from './push/service.ts';
import { webPushTransport } from './push/webpush.ts';
import { WorkflowService } from './workflows/service.ts';

const env = readEnv();
const db = connect(env.DATABASE_URL, { max: 16 });
const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
	? new GoogleIdentityProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, new URL('/auth/google/callback', env.API_URL).toString())
	: null;
if (!google) console.warn('[api] Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
const connections = new ConnectionService(db, env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
	? new GoogleConnector(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, new URL('/connections/google/callback', env.API_URL).toString()) : null,
	env.MASTER_KEY ? masterKey(env.MASTER_KEY) : null, env.APP_URL);
const inference = new InferenceService(db, env.MASTER_KEY ? masterKey(env.MASTER_KEY) : null);
const pushKeys = env.WEB_PUSH_PUBLIC_KEY && env.WEB_PUSH_PRIVATE_KEY && env.WEB_PUSH_SUBJECT ? { publicKey: env.WEB_PUSH_PUBLIC_KEY, privateKey: env.WEB_PUSH_PRIVATE_KEY, subject: env.WEB_PUSH_SUBJECT } : null;
if (!pushKeys) console.warn('[api] Web Push is not configured (WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY / WEB_PUSH_SUBJECT)');
const push = new PushService(db, pushKeys ? webPushTransport(pushKeys) : null, pushKeys?.publicKey ?? null);
const briefs = new BriefService(db);
const triage = new TriageService(db, connections, inference);
const registry = new StocktakeService(db, inference, push).register(new ChaseService(db).register(briefs.register(triage.registry(), inference, push), inference, push));
const engine = new BossEngine(db, env.DATABASE_URL, registry, definitions);
const stock = new StockService(db, (tx, org, event, data, key) => engine.emit(tx, org, event, data, key));
const outbox = new OutboxService(db, connections, (tx, org, run, key) => engine.wake(tx, org, run, key));
const stopAttachmentExpiry = startAttachmentExpiry(db);
if (env.WORKFLOWS_DISABLED !== '1') await engine.open().catch(async () => { console.error('[api] workflow runner unavailable; follow docs/runbooks/workflow-runner.md'); await engine.close(); });
const mailSync = new MailSync(db, connections, undefined, (tx, org, event, data) => engine.emit(tx, org, event, data));
const pushConfig = env.GMAIL_PUBSUB_TOPIC && env.GMAIL_PUSH_AUDIENCE ? { topic: env.GMAIL_PUBSUB_TOPIC, audience: env.GMAIL_PUSH_AUDIENCE } : undefined;
const gmailWatch = new GmailWatch(db, connections, pushConfig);
const gmailPush = pushConfig ? new GmailPush(db, mailSync, pushConfig) : undefined;
const stopGmailPush = startGmailPushSchedule(gmailPush, gmailWatch);
const stopMailSync = startMailSchedule(mailSync, env.MAIL_SYNC_DISABLED === '1');
const commitments = new CommitmentsService(db);
const stopSeries = startSeriesSchedule(new SeriesRoutine(db, commitments), env.SERIES_DISABLED === '1');
const calendarSync = new CalendarSync(db, connections);
const stopCalendarSync = startCalendarSchedule(calendarSync, env.CALENDAR_SYNC_DISABLED === '1');
const shopifyConnections = new ShopifyConnections(db, env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET ? new ShopifyConnector(env.SHOPIFY_CLIENT_ID, env.SHOPIFY_CLIENT_SECRET, new URL('/connections/shopify/callback', env.API_URL).toString()) : null, env.MASTER_KEY ? masterKey(env.MASTER_KEY) : null, env.APP_URL);
const shopifySync = new ShopifySync(shopifyConnections);
const stopShopifySync = startShopifySchedule(shopifySync, env.SHOPIFY_SYNC_DISABLED === '1' || !shopifyConnections.available);
const xeroConnections = new XeroConnections(db, env.XERO_CLIENT_ID ? new XeroConnector(env.XERO_CLIENT_ID, new URL('/connections/xero/callback', env.API_URL).toString()) : null, env.MASTER_KEY ? masterKey(env.MASTER_KEY) : null, env.APP_URL);
const xeroSync = new XeroSync(xeroConnections);
const stopXeroSync = startXeroSchedule(xeroSync, env.XERO_SYNC_DISABLED === '1' || !xeroConnections.available);
const workflows = new WorkflowService(db, push, engine);
// The catalogue is code; the table the API exposes follows it (plan §5 workflow_definitions).
await workflows.sync().catch((error) => console.error('[api] workflow catalogue sync failed', error instanceof Error ? error.message : error));
// Deletion revokes what it can at providers first, best effort, then the row and its tenant data go.
const lifecycle = new OrganisationLifecycle(db, [
 async (actor, organisationId) => { await shopifyConnections.disconnect(actor, organisationId).catch(() => undefined); },
	async (actor, organisationId) => { const list = await connections.list(actor, organisationId); for (const c of list.connections) if (c.provider === 'google' && c.status !== 'disconnected') await connections.disconnect(actor, organisationId, c.id).catch(() => undefined); },
	async (actor, organisationId) => { await xeroConnections.disconnect(actor, organisationId).catch(() => undefined); },
	async (actor, organisationId) => { await inference.remove(actor, organisationId).catch(() => undefined); }
]);
const passkeys = new PasskeyService(db, simpleWebAuthn(env.APP_URL));
const app = createApp({ stock, shopifyConnections, shopifySync, shopifyScheduleEnabled: env.SHOPIFY_SYNC_DISABLED !== '1' && shopifyConnections.available, outbox, passkeys, lifecycle, xeroConnections, xeroSync, xeroScheduleEnabled: env.XERO_SYNC_DISABLED !== '1' && xeroConnections.available, workflows, push, inference, db, gmailWatch, gmailPush, connections, calendarSync, calendarScheduleEnabled: env.CALENDAR_SYNC_DISABLED !== '1', mailSync, mailScheduleEnabled: env.MAIL_SYNC_DISABLED !== '1', auth: new AuthService(db, google, { appUrl: env.APP_URL, sessionTtlDays: env.SESSION_TTL_DAYS, passkeys }), organisations: new OrganisationService(db), commitments });


const server = serve({ fetch: app.fetch, port: env.PORT }, () => console.log(`[api] listening on ${env.PORT}`));
const shutdown = () => { server.close(); void Promise.all([stopShopifySync(), stopAttachmentExpiry(), stopXeroSync(), stopMailSync(), stopCalendarSync(), stopGmailPush(), stopSeries(), engine.close()]).then(() => db.end({ timeout: 5 })).then(() => process.exit(0)); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
