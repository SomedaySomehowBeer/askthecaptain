import { randomBytes } from 'node:crypto';
import { ShopifyConnector, shopDomain } from '@captain/connectors/shopify';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { hashSecret } from '../auth/service.ts';
import { newDataKey, open, seal } from '../connections/encryption.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
export type Actor = { userId: string; requestId: string };
const requestSchema = z.object({ organisationId: z.string().uuid(), shop: z.string() });
export async function shopifyRole(tx: TransactionSql, actor: Actor, org: string, manage = false) {
 const [row] = await tx`select role from memberships where organisation_id = ${org} and user_id = ${actor.userId} and status = 'active' for share`;
 if (!row) throw notFound(); if (manage && row.role === 'member') throw forbidden('Only owners and admins can manage Shopify.');
}
export async function shopifyState(tx: TransactionSql) {
 const [connection] = await tx`select id, provider_account_id, status, error from connections where provider = 'shopify' for share`;
 const [sync] = connection ? await tx`select cursor, updated_at from sync_cursors where connection_id = ${connection.id} and resource = 'shopify.state'` : [];
 const state = sync ? z.object({ complete: z.boolean(), lastSyncedAt: z.string().nullable(), error: z.string().nullable(), coverageSince: z.string().nullable() }).parse(JSON.parse(sync.cursor)) : { complete: false, lastSyncedAt: null, error: 'Shopify has not been synced yet. Choose Sync now in Settings.', coverageSince: null };
 if (!state.complete && state.error?.includes('sync is running')) {
  const [lock] = connection ? await tx`select id from sync_cursors where connection_id = ${connection.id} and resource = 'shopify.sync-lock' and updated_at > clock_timestamp() - interval '2 minutes'` : [];
  if (!lock) state.error = 'The previous Shopify sync did not finish. Choose Sync now in Settings.';
 }
 return { connection: connection ?? null, connected: connection?.status === 'connected', ...state, complete: connection?.status === 'connected' && state.complete,
  error: connection?.error ?? (connection?.status !== 'connected' ? 'Connect Shopify in Settings.' : state.error) };
}
export class ShopifyConnections {
 readonly db: Sql; readonly client: ShopifyConnector | null; readonly master: Buffer | null; readonly appUrl: string;
 constructor(db: Sql, client: ShopifyConnector | null, master: Buffer | null, appUrl: string) { this.db = db; this.client = client; this.master = master; this.appUrl = appUrl; }
 get available() { return Boolean(this.client && this.master); }
 async status(actor: Actor, org: string) { return withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => { await shopifyRole(tx, actor, org); return { ...await shopifyState(tx), available: this.available }; }); }
 async start(actor: Actor, org: string, input: string) {
  let shop: string; try { shop = shopDomain(input); } catch { throw badRequest('shop_invalid', 'Enter the shop’s myshopify.com domain without a URL or path.'); }
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await shopifyRole(tx, actor, org, true); this.requireAvailable(); const state = randomBytes(32).toString('base64url');
   await tx`insert into auth_requests (kind, token_hash, user_id, payload, expires_at) values ('shopify_connection', ${hashSecret(state)}, ${actor.userId}, ${tx.json({ organisationId: org, shop })}, ${new Date(Date.now() + 900_000)})`;
   await this.journal(tx, actor, org, 'shopify.connection_started', org);
   const url = new URL('/connections/shopify/authorize', this.client!.redirectUri); url.searchParams.set('state', state); return url.toString();
  });
 }
 // This browser hop sets an API-host nonce cookie before leaving for Shopify.
 async authorize(state: string) {
  this.requireAvailable();
  const [request] = await this.db`select user_id, payload from auth_requests where kind = 'shopify_connection' and token_hash = ${hashSecret(state)} and consumed_at is null and expires_at > now()`;
  if (!request) throw badRequest('shopify_link_expired', 'Start Connect Shopify again; that link has expired.');
  const { organisationId: org, shop } = requestSchema.parse(request.payload);
  await withTenant(this.db, { organisationId: org, userId: String(request.userId) }, (tx) => shopifyRole(tx, { userId: String(request.userId), requestId: 'shopify-authorize' }, org, true));
  return this.client!.authorizationUrl(shop, state);
 }
 async finish(query: URLSearchParams, cookie: string | undefined, requestId: string) {
  const target = new URL('/settings/connections', this.appUrl);
  try {
   this.requireAvailable(); const { shop, state, code } = this.client!.verifyCallback(query, cookie);
   const [request] = await this.db`update auth_requests set consumed_at = now() where kind = 'shopify_connection' and token_hash = ${hashSecret(state)} and consumed_at is null and expires_at > now() returning user_id, payload`;
   if (!request || !code || query.has('error')) throw new Error('invalid grant');
   const payload = requestSchema.parse(request.payload); if (shop !== payload.shop) throw new Error('shop mismatch');
   const org = payload.organisationId; const actor = { userId: String(request.userId), requestId };
   await withTenant(this.db, { organisationId: org, userId: actor.userId }, (tx) => shopifyRole(tx, actor, org, true));
   const tokens = await this.client!.exchange(shop, code);
   await withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
    await shopifyRole(tx, actor, org, true); const key = await this.key(tx, org, true);
    const [old] = await tx`select id, provider_account_id from connections where provider = 'shopify' for update`;
    if (old) {
     if (old.providerAccountId !== shop) { await tx`delete from shopify_products where connection_id = ${old.id}`; await tx`delete from shopify_orders where connection_id = ${old.id}`; }
     await tx`delete from sync_cursors where connection_id = ${old.id} and resource like 'shopify.%' and resource not like 'shopify.rate:%'`;
    }
    const [row] = await tx`insert into connections (organisation_id, provider, connected_by, provider_account_id, provider_account_name, scopes, status, access_token_encrypted)
     values (${org}, 'shopify', ${actor.userId}, ${shop}, ${shop}, ${tx.array(tokens.scopes)}, 'connected', ${seal(key, Buffer.from(tokens.accessToken), org, 'access_token')})
     on conflict (organisation_id, provider) do update set connected_by = excluded.connected_by, provider_account_id = excluded.provider_account_id, provider_account_name = excluded.provider_account_name,
     scopes = excluded.scopes, status = 'connected', error = null, access_token_encrypted = excluded.access_token_encrypted, refresh_token_encrypted = null, access_token_expires_at = null, updated_at = now() returning id`;
    await this.journal(tx, actor, org, 'shopify.connected', row!.id);
   }); target.searchParams.set('shopify', 'connected');
  } catch { target.searchParams.set('shopify', 'failed'); }
  return target.toString();
 }
 async accessToken(org: string, id: string, shop: string) {
  return withTenant(this.db, { organisationId: org }, async (tx) => {
   this.requireAvailable(); const [row] = await tx`select access_token_encrypted from connections where id = ${id} and provider = 'shopify' and provider_account_id = ${shop} and status = 'connected' for share`;
   if (!row?.accessTokenEncrypted) throw badRequest('shopify_disconnected', 'Reconnect Shopify in Settings.');
   return open(await this.key(tx, org), row.accessTokenEncrypted, org, 'access_token').toString();
  });
 }
 async disconnect(actor: Actor, org: string) {
  await withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await shopifyRole(tx, actor, org, true); const [row] = await tx`select * from connections where provider = 'shopify' for update`; if (!row) throw notFound();
   let revoked = row.status === 'disconnected';
   try { if (!revoked && this.client && row.accessTokenEncrypted) { await this.client.disconnect(row.providerAccountId, open(await this.key(tx, org), row.accessTokenEncrypted, org, 'access_token').toString()); revoked = true; } } catch { /* Always clear local access. */ }
   await tx`update connections set status = 'disconnected', access_token_encrypted = null, refresh_token_encrypted = null, access_token_expires_at = null,
    error = ${revoked ? null : 'Uninstall could not be confirmed. Remove Captain in Shopify’s Apps settings.'}, updated_at = now() where id = ${row.id}`;
   await tx`delete from sync_cursors where connection_id = ${row.id} and resource = 'shopify.sync-lock'`;
   await tx`update auth_requests set consumed_at = now(), payload = '{}' where kind = 'shopify_connection' and payload->>'organisationId' = ${org} and consumed_at is null`;
   await this.journal(tx, actor, org, 'shopify.disconnected', row.id);
  });
 }
 private requireAvailable() { if (!this.available) throw badRequest('shopify_unavailable', 'Shopify connections are not configured. Ask the owner to finish setup.'); }
 private async key(tx: TransactionSql, org: string, create = false): Promise<Buffer> {
  this.requireAvailable(); const rows = create ? await tx`select data_key_wrapped from organisations where id = ${org} for update` : await tx`select data_key_wrapped from organisations where id = ${org}`;
  if (rows[0]?.dataKeyWrapped) return open(this.master!, rows[0].dataKeyWrapped, org, 'data_key');
  if (!create) throw new Error('data key missing'); const key = newDataKey(this.master!, org);
  await tx`update organisations set data_key_wrapped = ${key.wrapped} where id = ${org}`;
  await audit(tx, { organisationId: org, actor: { kind: 'system' }, action: 'organisation.data_key_created', subjectType: 'organisation', subjectId: org }); return key.key;
 }
 private journal(tx: TransactionSql, actor: Actor, org: string, action: string, id: string) { return audit(tx, { organisationId: org, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId, action, subjectType: 'connection', subjectId: id }); }
}
