import { z } from 'zod';

const schema = z.object({
	PORT: z.coerce.number().int().positive().default(8080),
	DATABASE_URL: z.string().min(1),
	/** The web app's public origin: where sign-in returns to and the only origin allowed for it. */
	APP_URL: z.string().url(),
	/** This API's public origin, used for the Google redirect URI. */
	API_URL: z.string().url(),
	CALENDAR_SYNC_DISABLED: z.enum(['0', '1']).default('0'),
	GMAIL_PUBSUB_TOPIC: z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/).optional(),
	GMAIL_PUSH_AUDIENCE: z.string().url().optional(),
	MAIL_SYNC_DISABLED: z.enum(['0', '1']).default('0'),
	/** Stops the hourly materialise-series routine; set on throwaway servers so tests do not double-run it. */
	SERIES_DISABLED: z.enum(['0', '1']).default('0'),
	/** Web Push (plan §5 Notifications): all three or none; generated once, never rotated (docs/runbooks/web-push.md). */
	WEB_PUSH_PUBLIC_KEY: z.string().min(1).optional(),
	WEB_PUSH_PRIVATE_KEY: z.string().min(1).optional(),
	WEB_PUSH_SUBJECT: z.string().regex(/^mailto:.+@.+$/).optional(),
	MASTER_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),
	SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30)
}).refine((env) => Boolean(env.GMAIL_PUBSUB_TOPIC) === Boolean(env.GMAIL_PUSH_AUDIENCE), { path: ['GMAIL_PUBSUB_TOPIC', 'GMAIL_PUSH_AUDIENCE'], message: 'Configure both push settings together' });
export type Env = z.infer<typeof schema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
	const parsed = schema.safeParse(source);
	if (!parsed.success) throw new Error(`configuration is incomplete: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
	return parsed.data;
}
