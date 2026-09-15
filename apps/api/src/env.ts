import { z } from 'zod';

const schema = z.object({
	PORT: z.coerce.number().int().positive().default(8080),
	DATABASE_URL: z.string().min(1),
	/** The web app's public origin: where sign-in returns to and the only origin allowed for it. */
	APP_URL: z.string().url(),
	/** This API's public origin, used for the Google redirect URI. */
	API_URL: z.string().url(),
	MASTER_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/).optional(),
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),
	SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30)
});
export type Env = z.infer<typeof schema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
	const parsed = schema.safeParse(source);
	if (!parsed.success) throw new Error(`configuration is incomplete: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
	return parsed.data;
}
