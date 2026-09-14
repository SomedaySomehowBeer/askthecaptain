import { serve } from '@hono/node-server';
import { connect } from '@captain/db';
import { createApp } from './app.ts';
import { GoogleIdentityProvider } from './auth/google.ts';
import { AuthService } from './auth/service.ts';
import { readEnv } from './env.ts';
import { OrganisationService } from './organisations/service.ts';

const env = readEnv();
const db = connect(env.DATABASE_URL);
const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
	? new GoogleIdentityProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, new URL('/auth/google/callback', env.API_URL).toString())
	: null;
if (!google) console.warn('[api] Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
const app = createApp({ db, auth: new AuthService(db, google, { appUrl: env.APP_URL, sessionTtlDays: env.SESSION_TTL_DAYS }), organisations: new OrganisationService(db) });

const server = serve({ fetch: app.fetch, port: env.PORT }, () => console.log(`[api] listening on ${env.PORT}`));
const shutdown = () => { server.close(); void db.end({ timeout: 5 }).then(() => process.exit(0)); };
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
