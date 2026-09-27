export class GoogleError extends Error {
	readonly code = 'google_failed' as const;
	constructor() { super('google_failed'); }
}

/** Revokes a legacy Google mail/calendar grant when an owner or admin disconnects it (#133). Captain
 *  no longer requests, exchanges or refreshes these grants; Google sign-in lives in `apps/api` and is
 *  unaffected. No database, keys, logs or inference here. https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke */
export class GoogleConnector {
	readonly #fetcher: typeof fetch;
	/** The client arguments are kept so existing callers are unchanged until the grant path itself is
	 *  removed; revocation needs only the token. */
	constructor(_clientId: string, _clientSecret: string, _redirectUri: string, fetcher: typeof fetch = fetch) {
		this.#fetcher = fetcher;
	}
	async revoke(token: string): Promise<void> {
		const response = await this.request('https://oauth2.googleapis.com/revoke', { method: 'POST', body: new URLSearchParams({ token }) });
		if (!response.ok) throw new GoogleError();
	}
	private async request(url: string, init: RequestInit): Promise<Response> {
		try { return await this.#fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) }); }
		catch { throw new GoogleError(); } // Network errors must not expose request credentials.
	}
}
