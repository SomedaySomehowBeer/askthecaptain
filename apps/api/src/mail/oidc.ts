import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { HttpError, unauthorised } from '../errors.ts';
const headerSchema = z.object({ alg: z.literal('RS256'), kid: z.string().min(1).max(200), crit: z.never().optional() });
const claimsSchema = z.object({ iss: z.enum(['accounts.google.com', 'https://accounts.google.com']), aud: z.string(),
 email: z.string(), email_verified: z.literal(true), sub: z.string().min(1), iat: z.number().int(), exp: z.number().int() });
const invalid = () => unauthorised('Gmail push authentication failed.');
/** Verify locally against Google's rotating public certificates; never send the bearer token to a
 * token-info endpoint. The fixed service-account identity is as important as issuer and audience. */
export class GooglePushVerifier {
 readonly audience: string; readonly email: string; readonly fetcher: typeof fetch; readonly now: () => number;
 private keys = new Map<string, KeyObject>(); private expires = 0; private fetchedAt = -Infinity; private pending?: Promise<void>;
 constructor(audience: string, email: string, fetcher: typeof fetch = fetch, now = Date.now) { this.audience = audience; this.email = email; this.fetcher = fetcher; this.now = now; }
 async verify(authorization: string | undefined): Promise<void> {
  if (!authorization || authorization.length > 16_384) throw invalid();
  const parts = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!parts) throw invalid();
  let header: z.infer<typeof headerSchema>; let claims: z.infer<typeof claimsSchema>;
  try { header = headerSchema.parse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString())); claims = claimsSchema.parse(JSON.parse(Buffer.from(parts[2]!, 'base64url').toString())); }
  catch { throw invalid(); }
  const now = this.now() / 1000;
  if (claims.aud !== this.audience || claims.email !== this.email || claims.exp <= now || claims.iat > now + 60 || claims.exp <= claims.iat || claims.exp - claims.iat > 7200) throw invalid();
  // Coalesce refreshes and rate-limit unknown-key refreshes so random kids cannot flood Google.
  if (this.now() >= this.expires || (!this.keys.has(header.kid) && this.now() - this.fetchedAt >= 30_000)) await this.refresh();
  const key = this.keys.get(header.kid);
  if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[1]}.${parts[2]}`), key, Buffer.from(parts[3]!, 'base64url'))) throw invalid();
 }
 private async refresh() {
  if (this.pending) return this.pending;
  this.pending = (async () => {
   try {
    const response = await this.fetcher('https://www.googleapis.com/oauth2/v1/certs', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const certs = z.record(z.string(), z.string().max(8192)).parse(await response.json());
    if (!Object.keys(certs).length || Object.keys(certs).length > 20) throw new Error();
    const keys = new Map<string, KeyObject>();
    for (const [kid, pem] of Object.entries(certs)) { const key = createPublicKey(pem); if (key.asymmetricKeyType !== 'rsa') throw new Error(); keys.set(kid, key); }
    const maxAge = Number(/(?:^|,)\s*max-age=(\d+)/i.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 60);
    const age = Number(response.headers.get('age') ?? 0);
    this.keys = keys; this.fetchedAt = this.now(); this.expires = this.now() + Math.max(0, Math.min(86_400, maxAge) - (Number.isFinite(age) ? age : 0)) * 1000;
   } catch { throw new HttpError(503, 'push_certificates_unavailable', 'Gmail push authentication is temporarily unavailable.'); }
  })().finally(() => { this.pending = undefined; });
  return this.pending;
 }
}
