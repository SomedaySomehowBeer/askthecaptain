import { z } from 'zod';

const schema = z.object({
	PORT: z.coerce.number().int().positive().default(8080),
	DATABASE_URL: z.string().min(1),
	/** The web app's public origin: where sign-in returns to and the only origin allowed for it. */
	APP_URL: z.string().url(),
	/** This API's public origin, used for the Google redirect URI. */
	API_URL: z.string().url(),
	SHOPIFY_CLIENT_ID: z.string().min(1).optional(),
	SHOPIFY_CLIENT_SECRET: z.string().min(1).optional(),
	SHOPIFY_SYNC_DISABLED: z.enum(['0', '1']).default('0'),
	XERO_CLIENT_ID: z.string().min(1).optional(),
	XERO_SYNC_DISABLED: z.enum(['0', '1']).default('0'),
	CALENDAR_SYNC_DISABLED: z.enum(['0', '1']).default('0'),
	GMAIL_PUBSUB_TOPIC: z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/).optional(),
	GMAIL_PUSH_AUDIENCE: z.string().url().optional(),
	WORKFLOWS_DISABLED: z.enum(['0', '1']).default('0'),
	MAIL_SYNC_DISABLED: z.enum(['0', '1']).default('0'),
	/** Stops the hourly materialise-series routine; set on throwaway servers so tests do not double-run it. */
	SERIES_DISABLED: z.enum(['0', '1']).default('0'),
	/** Web Push (plan §5 Notifications): all three or none; generated once, never rotated (docs/runbooks/web-push.md). */
	WEB_PUSH_PUBLIC_KEY: z.string().min(1).optional(),
	WEB_PUSH_PRIVATE_KEY: z.string().min(1).optional(),
	WEB_PUSH_SUBJECT: z.string().regex(/^mailto:.+@.+$/).optional(),
	MASTER_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
	/** A Sprites API token scoped to the organisation that holds only Captain runtimes (D18). Absent: runtimes cannot be created. */
	SPRITES_API_TOKEN: z.string().min(1).optional(),
	// The embedding service (D21). Unset means no index yet: rows stay unembedded for housekeeping to fill later.
	EMBED_URL: z.string().url().optional(),
	EMBED_TOKEN: z.string().min(32).optional(),
	INDEX_DISABLED: z.enum(['0', '1']).default('0'),
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),
	SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30)
}).refine((env) => Boolean(env.SHOPIFY_CLIENT_ID) === Boolean(env.SHOPIFY_CLIENT_SECRET), { path: ['SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'], message: 'Configure both Shopify credentials together' }).refine((env) => Boolean(env.GMAIL_PUBSUB_TOPIC) === Boolean(env.GMAIL_PUSH_AUDIENCE), { path: ['GMAIL_PUBSUB_TOPIC', 'GMAIL_PUSH_AUDIENCE'], message: 'Configure both push settings together' });
export type Env = z.infer<typeof schema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
	const parsed = schema.safeParse(source);
	if (!parsed.success) throw new Error(`configuration is incomplete: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
	return parsed.data;
}
