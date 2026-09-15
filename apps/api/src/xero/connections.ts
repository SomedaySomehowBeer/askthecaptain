import { createHash, randomBytes } from 'node:crypto';
import { XeroConnector, xeroScopes, type XeroTokens } from '@captain/connectors/xero';
import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { hashSecret } from '../auth/service.ts';
import { newDataKey, open, seal } from '../connections/encryption.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
export type Actor = { userId: string; requestId: string };
const pending = z.object({ organisationId: z.string().uuid(), encrypted: z.string(), expiresAt: z.string(), scopes: z.array(z.string()), tenants: z.array(z.object({ tenantId: z.string(), tenantName: z.string() })) });
export async function xeroRole(tx: TransactionSql, actor: Actor, org: string, manage = false) {
 const [row] = await tx`select role from memberships where organisation_id = ${org} and user_id = ${actor.userId} and status = 'active' for share`;
 if (!row) throw notFound(); if (manage && row.role === 'member') throw forbidden('Only owners and admins can manage Xero.');
}
export class XeroConnections {
 readonly db: Sql; readonly client: XeroConnector | null; readonly master: Buffer | null; readonly appUrl: string;
 constructor(db: Sql, client: XeroConnector | null, master: Buffer | null, appUrl: string) { this.db = db; this.client = client; this.master = master; this.appUrl = appUrl; }
 get available() { return Boolean(this.client && this.master); }
 async status(actor: Actor, org: string) {
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await xeroRole(tx, actor, org);
   const [connection] = await tx`select id, provider_account_id, provider_account_name, status, error from connections where provider = 'xero' for share`;
   const [selection] = await tx`select id, payload from auth_requests where kind = 'xero_selection' and user_id = ${actor.userId} and payload->>'organisationId' = ${org} and consumed_at is null and expires_at > now() order by created_at desc limit 1`;
   const [sync] = await tx`select action, detail, created_at from audit_events where subject_id = ${connection?.id ?? org} and action in ('xero.sync_started', 'xero.synced', 'xero.sync_failed') order by created_at desc, id desc limit 1`;
   const [last] = await tx`select created_at from audit_events where subject_id = ${connection?.id ?? org} and action = 'xero.synced' and created_at >= coalesce((select max(created_at) from audit_events where subject_id = ${connection?.id ?? org} and action = 'xero.connected'), 'epoch'::timestamptz) order by created_at desc, id desc limit 1`;
   return { available: this.available, connection: connection ?? null, selection: selection ? { id: selection.id as string, tenants: pending.parse(selection.payload).tenants } : null,
    lastSyncedAt: last?.createdAt ?? null, complete: connection?.status === 'connected' && sync?.action === 'xero.synced', syncError: sync && sync.action !== 'xero.synced' ? String(sync.detail.error) : null };
  });
 }
 async start(actor: Actor, org: string) {
  return withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await xeroRole(tx, actor, org, true); this.requireAvailable();
   const state = randomBytes(32).toString('base64url'); const verifier = randomBytes(32).toString('base64url');
   await tx`insert into auth_requests (kind, token_hash, user_id, payload, expires_at) values ('xero_connection', ${hashSecret(state)}, ${actor.userId}, ${tx.json({ organisationId: org, verifier })}, ${new Date(Date.now() + 900_000)})`;
   await this.journal(tx, actor, org, 'xero.connection_started', org);
   return this.client!.authorizationUrl(state, createHash('sha256').update(verifier).digest('base64url'));
  });
 }
 async finish(code: string, state: string, providerError: string | undefined, requestId: string) {
  const target = new URL('/settings/connections', this.appUrl);
  try {
   const [request] = await this.db`update auth_requests set consumed_at = now() where kind = 'xero_connection' and token_hash = ${hashSecret(state)} and consumed_at is null and expires_at > now() returning user_id, payload`;
   if (!request || providerError || !code) throw new Error('invalid grant'); this.requireAvailable();
   const { organisationId: org, verifier } = z.object({ organisationId: z.string().uuid(), verifier: z.string() }).parse(request.payload);
   const actor = { userId: String(request.userId), requestId };
   // Check the bound person's role before exchanging any credential.
   await withTenant(this.db, { organisationId: org, userId: actor.userId }, (tx) => xeroRole(tx, actor, org, true));
   const tokens = await this.client!.exchange(code, verifier); this.checkScopes(tokens);
   const tenants = (await this.client!.tenants(tokens.accessToken)).map(({ tenantId, tenantName }) => ({ tenantId, tenantName }));
   if (!tenants.length) throw new Error('no tenant');
   await withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
    await xeroRole(tx, actor, org, true); const key = await this.key(tx, org, true);
    await tx`update auth_requests set consumed_at = now(), payload = '{}' where kind = 'xero_selection' and user_id = ${actor.userId} and payload->>'organisationId' = ${org} and consumed_at is null`;
    await tx`insert into auth_requests (kind, token_hash, user_id, payload, expires_at) values ('xero_selection', ${hashSecret(randomBytes(32).toString('hex'))}, ${actor.userId},
     ${tx.json({ organisationId: org, encrypted: seal(key, Buffer.from(JSON.stringify(tokens)), org, 'xero_selection').toString('base64'), expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(), scopes: tokens.scopes, tenants })}, ${new Date(Date.now() + 600_000)})`;
    await this.journal(tx, actor, org, 'xero.selection_ready', org);
   }); target.searchParams.set('xero', 'select');
  } catch { target.searchParams.set('xero', 'failed'); }
  return target.toString();
 }
 async select(actor: Actor, org: string, selectionId: string, tenantId: string) {
  await withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await xeroRole(tx, actor, org, true); this.requireAvailable();
   const [request] = await tx`select payload from auth_requests where id = ${selectionId} and kind = 'xero_selection' and user_id = ${actor.userId} and payload->>'organisationId' = ${org} and consumed_at is null and expires_at > now() for update`;
   if (!request) throw badRequest('selection_expired', 'Start Connect Xero again; that selection has expired.');
   const p = pending.parse(request.payload); const tenant = p.tenants.find((t) => t.tenantId === tenantId);
   if (!tenant) throw badRequest('invalid_tenant', 'Choose an organisation from the Xero list.');
   const key = await this.key(tx, org); const tokens = JSON.parse(open(key, Buffer.from(p.encrypted, 'base64'), org, 'xero_selection').toString()) as XeroTokens;
   // Lock before replacing a grant. Each sync page checks this account and lease before committing.
   const [old] = await tx`select id, provider_account_id from connections where provider = 'xero' for update`;
   if (old) {
    await tx`delete from xero_contacts where connection_id = ${old.id}`;
    await tx`delete from sync_cursors where connection_id = ${old.id} and resource like 'xero.%' and resource not like 'xero.rate:%'`;
   }
   const [row] = await tx`insert into connections (organisation_id, provider, connected_by, provider_account_id, provider_account_name, scopes, status, access_token_encrypted, refresh_token_encrypted, access_token_expires_at)
    values (${org}, 'xero', ${actor.userId}, ${tenant.tenantId}, ${tenant.tenantName}, ${tx.array(p.scopes)}, 'connected', ${seal(key, Buffer.from(tokens.accessToken), org, 'access_token')}, ${seal(key, Buffer.from(tokens.refreshToken), org, 'refresh_token')}, ${p.expiresAt})
    on conflict (organisation_id, provider) do update set connected_by = excluded.connected_by, provider_account_id = excluded.provider_account_id, provider_account_name = excluded.provider_account_name,
    scopes = excluded.scopes, status = 'connected', error = null, access_token_encrypted = excluded.access_token_encrypted, refresh_token_encrypted = excluded.refresh_token_encrypted, access_token_expires_at = excluded.access_token_expires_at, updated_at = now() returning id`;
   await tx`update auth_requests set consumed_at = now(), payload = '{}' where id = ${selectionId}`;
   await this.journal(tx, actor, org, 'xero.connected', row!.id);
   await this.journal(tx, undefined, org, 'xero.sync_started', row!.id, { error: 'Xero has not been synced yet. Choose Sync now.' });
  });
 }
 async accessToken(actor: Actor | undefined, org: string, id: string): Promise<string> {
  const token = await withTenant(this.db, { organisationId: org, userId: actor?.userId }, async (tx) => {
   if (actor) await xeroRole(tx, actor, org); this.requireAvailable();
   const [row] = await tx`select * from connections where id = ${id} and provider = 'xero' for update`;
   if (!row || !['connected', 'refresh_failed'].includes(row.status)) throw badRequest('xero_disconnected', 'Reconnect Xero in Settings.');
   const key = await this.key(tx, org);
   if (row.accessTokenEncrypted && row.accessTokenExpiresAt?.getTime() > Date.now() + 60_000) return open(key, row.accessTokenEncrypted, org, 'access_token').toString();
   try {
    if (!row.refreshTokenEncrypted) throw new Error('missing refresh');
    const tokens = await this.client!.refresh(open(key, row.refreshTokenEncrypted, org, 'refresh_token').toString()); this.checkScopes(tokens);
    await tx`update connections set access_token_encrypted = ${seal(key, Buffer.from(tokens.accessToken), org, 'access_token')}, refresh_token_encrypted = ${seal(key, Buffer.from(tokens.refreshToken), org, 'refresh_token')}, access_token_expires_at = ${new Date(Date.now() + tokens.expiresIn * 1000)}, scopes = ${tx.array(tokens.scopes)}, status = 'connected', error = null, updated_at = now() where id = ${id}`;
    await this.journal(tx, actor, org, 'xero.refreshed', id); return tokens.accessToken;
   } catch {
    await tx`update connections set status = 'refresh_failed', error = 'Xero access could not be refreshed. Reconnect Xero in Settings.', updated_at = now() where id = ${id}`;
    await this.journal(tx, actor, org, 'xero.refresh_failed', id); return null;
   }
  }); if (!token) throw badRequest('xero_refresh_failed', 'Reconnect Xero in Settings.'); return token;
 }
 async disconnect(actor: Actor, org: string) {
  await withTenant(this.db, { organisationId: org, userId: actor.userId }, (tx) => xeroRole(tx, actor, org, true));
  const status = await this.status(actor, org); if (!status.connection) throw notFound();
  // Refresh first; the locked transaction below re-reads the latest token and account.
  await this.accessToken(actor, org, status.connection.id).catch(() => undefined);
  await withTenant(this.db, { organisationId: org, userId: actor.userId }, async (tx) => {
   await xeroRole(tx, actor, org, true); const [row] = await tx`select * from connections where provider = 'xero' for update`; if (!row || row.status === 'disconnected') return;
   let revoked = false;
   try { if (this.client && row.accessTokenEncrypted) { await this.client.disconnect(open(await this.key(tx, org), row.accessTokenEncrypted, org, 'access_token').toString(), row.providerAccountId); revoked = true; } } catch { /* Local credentials must still be cleared. */ }
   await tx`update connections set status = 'disconnected', access_token_encrypted = null, refresh_token_encrypted = null, access_token_expires_at = null,
    error = ${revoked ? null : 'Revocation could not be confirmed. Remove Captain in Xero’s Connected apps.'}, updated_at = now() where id = ${row.id}`;
   await tx`update auth_requests set consumed_at = now(), payload = '{}' where kind = 'xero_selection' and payload->>'organisationId' = ${org} and consumed_at is null`;
   await this.journal(tx, actor, org, 'xero.disconnected', row.id);
  });
 }
 private requireAvailable() { if (!this.available) throw badRequest('xero_unavailable', 'Xero connections are not configured. Ask the owner to finish setup.'); }
 private checkScopes(tokens: XeroTokens) { if (!xeroScopes.every((scope) => tokens.scopes.includes(scope))) throw new Error('Xero scopes missing'); }
 private async key(tx: TransactionSql, org: string, create = false): Promise<Buffer> {
  this.requireAvailable(); const rows = create ? await tx`select data_key_wrapped from organisations where id = ${org} for update` : await tx`select data_key_wrapped from organisations where id = ${org}`;
  if (rows[0]?.dataKeyWrapped) return open(this.master!, rows[0].dataKeyWrapped, org, 'data_key');
  if (!create) throw new Error('data key missing'); const key = newDataKey(this.master!, org);
  await tx`update organisations set data_key_wrapped = ${key.wrapped} where id = ${org}`;
  await this.journal(tx, undefined, org, 'organisation.data_key_created', org); return key.key;
 }
 private journal(tx: TransactionSql, actor: Actor | undefined, org: string, action: string, id: string, detail = {}) {
  return audit(tx, { organisationId: org, actor: actor ? { kind: 'person', id: actor.userId } : { kind: 'system' }, requestId: actor?.requestId, action, subjectType: 'connection', subjectId: id, detail });
 }
}
