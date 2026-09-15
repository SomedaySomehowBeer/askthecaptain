/** First-party, read-only Xero client. Credentials never leave this server-side seam. */
export const xeroScopes = ['offline_access', 'accounting.invoices.read', 'accounting.payments.read', 'accounting.contacts.read', 'accounting.reports.aged.read', 'accounting.reports.balancesheet.read', 'accounting.reports.banksummary.read', 'accounting.reports.budgetsummary.read', 'accounting.reports.executivesummary.read', 'accounting.reports.profitandloss.read', 'accounting.reports.trialbalance.read', 'accounting.reports.taxreports.read'];
export type XeroTokens = { accessToken: string; refreshToken: string; expiresIn: number; scopes: string[] };
export type XeroTenant = { id: string; tenantId: string; tenantName: string };
export type Resource = 'Contacts' | 'Invoices' | 'Payments';
export class XeroError extends Error {
 readonly status: number; readonly retryAfter: number;
 constructor(status = 502, retryAfter = 60) { super('Xero request failed'); this.status = status; this.retryAfter = retryAfter; }
}
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new XeroError(); return v as Record<string, unknown>; };
export class XeroConnector {
 readonly #clientId: string; readonly #redirectUri: string; readonly #fetch: typeof fetch;
 constructor(clientId: string, redirectUri: string, fetcher = fetch) { this.#clientId = clientId; this.#redirectUri = redirectUri; this.#fetch = fetcher; }
 authorizationUrl(state: string, challenge: string) {
  const url = new URL('https://login.xero.com/identity/connect/authorize');
  url.search = new URLSearchParams({ response_type: 'code', client_id: this.#clientId, redirect_uri: this.#redirectUri, scope: xeroScopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' }).toString(); return url.toString();
 }
 async exchange(code: string, verifier: string) { return this.tokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.#redirectUri }); }
 async refresh(refreshToken: string) { return this.tokens({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
 private async tokens(body: Record<string, string>): Promise<XeroTokens> {
  const raw = record(await (await this.request('https://identity.xero.com/connect/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(body.grant_type === 'refresh_token' ? { authorization: `Basic ${Buffer.from(`${this.#clientId}:`).toString('base64')}` } : {}) }, body: new URLSearchParams({ ...body, client_id: this.#clientId }) })).json());
  if (typeof raw.access_token !== 'string' || !raw.access_token || typeof raw.refresh_token !== 'string' || !raw.refresh_token || typeof raw.expires_in !== 'number' || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0 || (raw.scope !== undefined && typeof raw.scope !== 'string')) throw new XeroError();
  return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresIn: raw.expires_in, scopes: typeof raw.scope === 'string' ? raw.scope.split(' ') : xeroScopes };
 }
 async tenants(token: string): Promise<XeroTenant[]> {
  const raw: unknown = await (await this.request('https://api.xero.com/connections', { headers: { authorization: `Bearer ${token}` } })).json();
  if (!Array.isArray(raw) || raw.length > 1000) throw new XeroError();
  return raw.map((v) => { const r = record(v); if (![r.id, r.tenantId, r.tenantName].every((s) => typeof s === 'string' && s.length > 0)) throw new XeroError(); return { id: r.id as string, tenantId: r.tenantId as string, tenantName: r.tenantName as string }; });
 }
 /** Revoke only the selected tenant connection. Revoking a refresh token removes every tenant
  * on that user's grant, which can disconnect another Captain organisation. */
 async disconnect(token: string, tenantId: string) {
  const tenant = (await this.tenants(token)).find((t) => t.tenantId === tenantId);
  if (tenant) await this.request(`https://api.xero.com/connections/${encodeURIComponent(tenant.id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
 }
 async page(token: string, tenantId: string, resource: Resource, page: number, modifiedSince?: string): Promise<unknown[]> {
  const url = new URL(`https://api.xero.com/api.xro/2.0/${resource}`);
  url.search = new URLSearchParams({ page: String(page), pageSize: '100', ...(resource === 'Contacts' ? { includeArchived: 'true' } : {}) }).toString();
  return this.items(url, token, tenantId, resource, modifiedSince);
 }
 async one(token: string, tenantId: string, resource: 'Contacts' | 'Invoices', id: string) {
  const items = await this.items(new URL(`https://api.xero.com/api.xro/2.0/${resource}/${encodeURIComponent(id)}`), token, tenantId, resource);
  if (items.length !== 1) throw new XeroError(); return items[0];
 }
 private async items(url: URL, token: string, tenantId: string, resource: Resource, modifiedSince?: string) {
  const response = await this.request(url.toString(), { headers: { authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId, ...(modifiedSince ? { 'if-modified-since': modifiedSince } : {}) } });
  if (response.status === 304) return [];
  const items = record(await response.json())[resource]; if (!Array.isArray(items) || items.length > 100) throw new XeroError(); return items as unknown[];
 }
 private async request(url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try { response = await this.#fetch(url, { ...init, headers: { accept: 'application/json', ...init.headers }, signal: AbortSignal.timeout(15_000), redirect: 'error' }); } catch { throw new XeroError(); }
  if (!response.ok && response.status !== 304) {
   const raw = response.headers.get('retry-after'); const seconds = raw && /^\d+$/.test(raw) ? Number(raw) : raw ? (Date.parse(raw) - Date.now()) / 1000 : 60;
   throw new XeroError(response.status, Number.isFinite(seconds) ? Math.max(1, seconds) : 60);
  }
  return response;
 }
}
