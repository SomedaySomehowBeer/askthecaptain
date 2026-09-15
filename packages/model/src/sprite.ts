import { InferenceError, errorCodes, resultSchema, type Provider, type Request, type Result } from './index.ts';
/** URL and secret stay in this transport; neither is part of the model's request data. */
export class SpriteProvider implements Provider {
 readonly url: string; private readonly secret: string; private readonly transport: typeof fetch;
 constructor(url: string, secret: string, transport: typeof fetch = fetch) {
  this.url = url; this.secret = secret; this.transport = transport;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.sprites\.app$/.test(parsed.hostname) || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new InferenceError('runtime_not_ready');
 }
 private async call(path: string, body?: Request) {
  try {
   const response = await this.transport(new URL(path, this.url), { method: body ? 'POST' : 'GET', redirect: 'error', headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000) });
   if (response.status === 401) throw new InferenceError('runtime_not_ready');
   if (response.status === 429) throw new InferenceError('rate_limited');
   const raw = await response.text(); if (raw.length > 1048576) throw new InferenceError('provider_unavailable');
   const data = JSON.parse(raw) as { code?: unknown; ok?: boolean };
   if (!response.ok) throw new InferenceError(errorCodes.find(c => c === data.code) ?? 'provider_unavailable');
   return data;
  } catch (error) { throw error instanceof InferenceError ? error : new InferenceError('provider_unavailable'); }
 }
 async health() { const data = await this.call('/health'); if (data.ok !== true) throw new InferenceError('runtime_not_ready'); }
 async infer(request: Request): Promise<Result> {
  const result = resultSchema.safeParse(await this.call('/infer', request));
  if (!result.success) throw new InferenceError('provider_unavailable'); return result.data;
 }
}
