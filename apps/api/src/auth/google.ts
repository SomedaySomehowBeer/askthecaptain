import { z } from 'zod';
import { HttpError } from '../errors.ts';

export type GoogleIdentity = { subject: string; email: string; name: string };
export interface IdentityProvider {
	authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string;
	exchange(input: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity>;
}

/** Google OpenID Connect with PKCE. The id token is verified through Google's tokeninfo endpoint
 *  and its audience, issuer and nonce are checked here; only a verified email is accepted. */
export class GoogleIdentityProvider implements IdentityProvider {
	readonly #clientId: string; readonly #clientSecret: string; readonly #redirectUri: string; readonly #fetch: typeof fetch;
	constructor(clientId: string, clientSecret: string, redirectUri: string, fetcher: typeof fetch = fetch) {
		this.#clientId = clientId; this.#clientSecret = clientSecret; this.#redirectUri = redirectUri; this.#fetch = fetcher;
	}
	authorizationUrl(input: { state: string; nonce: string; codeChallenge: string }): string {
		const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
		url.search = new URLSearchParams({ client_id: this.#clientId, redirect_uri: this.#redirectUri, response_type: 'code', scope: 'openid email profile',
			state: input.state, nonce: input.nonce, code_challenge: input.codeChallenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString();
		return url.toString();
	}
	async exchange(input: { code: string; codeVerifier: string; nonce: string }): Promise<GoogleIdentity> {
		const tokenResponse = await this.#fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({ code: input.code, client_id: this.#clientId, client_secret: this.#clientSecret, redirect_uri: this.#redirectUri,
				grant_type: 'authorization_code', code_verifier: input.codeVerifier }) });
		if (!tokenResponse.ok) throw new HttpError(401, 'google_failed', 'Google sign-in failed');
		const tokens = z.object({ id_token: z.string() }).parse(await tokenResponse.json());
		const info = await this.#fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokens.id_token)}`);
		if (!info.ok) throw new HttpError(401, 'google_failed', 'Google identity could not be verified');
		const claims = z.object({ sub: z.string(), email: z.string().email(), email_verified: z.union([z.literal('true'), z.literal(true)]),
			name: z.string().default(''), aud: z.string(), iss: z.string(), nonce: z.string() }).parse(await info.json());
		if (claims.aud !== this.#clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.nonce !== input.nonce)
			throw new HttpError(401, 'google_failed', 'Google identity claims are invalid');
		return { subject: claims.sub, email: claims.email.trim().toLowerCase(), name: claims.name || claims.email.split('@')[0]! };
	}
}
