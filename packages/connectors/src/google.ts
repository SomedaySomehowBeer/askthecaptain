export const googleScopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/calendar.events'];
export type GoogleTokens = { accessToken: string; refreshToken?: string; expiresIn: number; scopes?: string[] };
export class GoogleError extends Error {
	readonly code: 'google_failed' | 'grant_revoked';
	constructor(code: 'google_failed' | 'grant_revoked' = 'google_failed') { super(code); this.code = code; }
}
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoogleError();
	return value as Record<string, unknown>;
};

/** Our OAuth and minimal Gmail REST client. No database, keys, logs or inference here.
 * https://developers.google.com/identity/protocols/oauth2/web-server */
export class GoogleConnector {
	readonly #clientId: string; readonly #clientSecret: string; readonly #redirectUri: string; readonly #fetcher: typeof fetch;
	constructor(clientId: string, clientSecret: string, redirectUri: string, fetcher: typeof fetch = fetch) {
		this.#clientId = clientId; this.#clientSecret = clientSecret; this.#redirectUri = redirectUri; this.#fetcher = fetcher;
	}
	authorizationUrl(input: { state: string; codeChallenge: string }): string {
		const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
		url.search = new URLSearchParams({ client_id: this.#clientId, redirect_uri: this.#redirectUri, response_type: 'code',
			scope: googleScopes.join(' '), state: input.state, code_challenge: input.codeChallenge, code_challenge_method: 'S256',
			access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }).toString();
		return url.toString();
	}
	exchange(input: { code: string; codeVerifier: string }): Promise<GoogleTokens> {
		return this.tokens({ grant_type: 'authorization_code', code: input.code, code_verifier: input.codeVerifier, redirect_uri: this.#redirectUri });
	}
	/** The API calls this while holding the connection row lock, and persists before releasing it. */
	refresh(refreshToken: string): Promise<GoogleTokens> { return this.tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
	async profile(accessToken: string): Promise<{ emailAddress: string }> {
		const response = await this.request('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${accessToken}` } });
		if (!response.ok) throw new GoogleError();
		const data = record(await response.json().catch(() => null));
		if (typeof data.emailAddress !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.emailAddress)) throw new GoogleError();
		return { emailAddress: data.emailAddress.trim().toLowerCase() };
	}
	async revoke(token: string): Promise<void> {
		const response = await this.request('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }) });
		if (!response.ok) throw new GoogleError();
	}
	private async tokens(params: Record<string, string>): Promise<GoogleTokens> {
		const response = await this.request('https://oauth2.googleapis.com/token', { method: 'POST',
			body: new URLSearchParams({ ...params, client_id: this.#clientId, client_secret: this.#clientSecret }) });
		const data = record(await response.json().catch(() => null));
		if (!response.ok) throw new GoogleError(data.error === 'invalid_grant' ? 'grant_revoked' : 'google_failed');
		if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number'
			|| !Number.isFinite(data.expires_in) || data.expires_in <= 0 || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer'
			|| (data.refresh_token !== undefined && (typeof data.refresh_token !== 'string' || !data.refresh_token))
			|| (data.scope !== undefined && typeof data.scope !== 'string')) throw new GoogleError();
		return { accessToken: data.access_token, expiresIn: data.expires_in, refreshToken: data.refresh_token as string | undefined,
			scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : undefined };
	}
	private async request(url: string, init: RequestInit): Promise<Response> {
		try { return await this.#fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) }); }
		catch { throw new GoogleError(); } // Network errors must not expose request credentials.
	}
}
