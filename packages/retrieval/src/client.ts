/** The client for the embedding service (`infra/embed`, D21). Text goes out over TLS with the bearer
 *  secret and comes back as numbers. Failures never carry the text: the caller leaves rows unembedded. */
export type Embedding = { encoder: string; version: string; dimensions: number; vectors: number[][] };
export type EmbedClient = {
	/** Which encoder the service runs, from /healthz; cached after the first answer. */
	identity(): Promise<{ encoder: string; version: string; dimensions: number }>;
	embed(units: string[]): Promise<Embedding>;
};
export const MAX_UNITS_PER_REQUEST = 64;
export class EmbedUnavailable extends Error {
	readonly status: number | null;
	constructor(status: number | null, reason: string) { super(`embedding service unavailable: ${reason}`); this.name = 'EmbedUnavailable'; this.status = status; }
}
export function httpEmbedClient(url: string, token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 60_000): EmbedClient {
	const base = url.replace(/\/$/, ''); let known: Promise<{ encoder: string; version: string; dimensions: number }> | undefined;
	const call = async (path: string, init: RequestInit) => {
		let response: Response;
		try { response = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) }); }
		catch (error) { throw new EmbedUnavailable(null, error instanceof Error ? error.name : 'fetch failed'); }
		if (!response.ok) throw new EmbedUnavailable(response.status, `HTTP ${response.status}`);
		return response.json() as Promise<Record<string, unknown>>;
	};
	return {
		identity() {
			known ??= call('/healthz', { method: 'GET' }).then((body) => {
				if (typeof body.encoder !== 'string' || typeof body.version !== 'string' || typeof body.dimensions !== 'number') throw new EmbedUnavailable(200, 'unexpected health answer');
				return { encoder: body.encoder, version: body.version, dimensions: body.dimensions };
			}).catch((error) => { known = undefined; throw error; });
			return known;
		},
		async embed(units) {
			if (units.length === 0) return { ...(await this.identity()), vectors: [] };
			if (units.length > MAX_UNITS_PER_REQUEST) throw new RangeError(`at most ${MAX_UNITS_PER_REQUEST} units per request`);
			const body = await call('/embed', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ units }) });
			const vectors = body.vectors;
			if (!Array.isArray(vectors) || vectors.length !== units.length || typeof body.encoder !== 'string' || typeof body.version !== 'string' || typeof body.dimensions !== 'number') throw new EmbedUnavailable(200, 'unexpected answer shape');
			return { encoder: body.encoder, version: body.version, dimensions: body.dimensions, vectors: vectors as number[][] };
		}
	};
}
