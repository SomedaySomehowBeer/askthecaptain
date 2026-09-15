import { MailSync, startMailSchedule } from './mail/sync.ts';
import { GoogleConnector } from '@captain/connectors';
import { ConnectionService } from './connections/service.ts';
import { masterKey } from './connections/encryption.ts';
import { serve } from '@hono/node-server';
import { connect } from '@captain/db';
import { createApp } from './app.ts';
import { GoogleIdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { CommitmentsService } from './commitments/service.ts';
import { readEnv } from './env.ts';
import { OrganisationService } from './organisations/service.ts';

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
const stopMailSync = startMailSchedule(mailSync, env.MAIL_SYNC_DISABLED === '1');
const app = createApp({ db, connections, mailSync, mailScheduleEnabled: env.MAIL_SYNC_DISABLED !== '1', auth: new AuthService(db, google, { appUrl: env.APP_URL, sessionTtlDays: env.SESSION_TTL_DAYS }), organisations: new OrganisationService(db), commitments: new CommitmentsService(db) });


const server = serve({ fetch: app.fetch, port: env.PORT }, () => console.log(`[api] listening on ${env.PORT}`));
const shutdown = () => { server.close(); void stopMailSync().then(() => db.end({ timeout: 5 })).then(() => process.exit(0)); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
