import { mailLock, syncBusy } from './lock.ts';
import { upkeepContacts } from '../contacts/upkeep.ts';
import { GmailClient, GmailError, type MailThread } from '@captain/connectors/gmail';
import { withTenant, type Sql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import type { ConnectionService } from '../connections/service.ts';
import { badRequest, HttpError } from '../errors.ts';
import { connection, saveThread } from './store.ts';
const cursorSchema = z.object({ accountEmail: z.string(), historyId: z.string().min(1), capped: z.boolean() });
export type SyncResult = { threads: number; messages: number; attachments: number; deleted: number; full: boolean; capped: boolean };

/** Housekeeping, never a workflow. Fetch outside transactions, commit mail and contacts in batches,
 * and advance the history cursor only after success. A retry idempotently replays unfinished work.
 * TODO: Gmail Pub/Sub webhook push, verification and history-triggered sync in a later PR. */
export class MailSync {
	readonly #running = new Set<string>(); readonly #db: Sql; readonly #connections: ConnectionService; readonly #gmail: GmailClient;
	constructor(db: Sql, connections: ConnectionService, gmail = new GmailClient()) { this.#db = db; this.#connections = connections; this.#gmail = gmail; }
	async organisations(): Promise<string[]> {
		return (await this.#db<{ organisationId: string }[]>`select organisation_id from gmail_sync_organisations()`).map((row) => row.organisationId);
	}
	async run(organisationId: string): Promise<SyncResult> {
		if (this.#running.has(organisationId)) throw syncBusy();
		this.#running.add(organisationId);
		let lock: Awaited<ReturnType<typeof mailLock>> | undefined;
		const counts: SyncResult = { threads: 0, messages: 0, attachments: 0, deleted: 0, full: false, capped: false };
		try {
			const conn = await withTenant(this.#db, { organisationId }, connection);
			if (!conn || conn.status !== 'connected') throw badRequest('connection_unavailable', 'Connect or reconnect Google in Settings before syncing mail.');
			lock = await mailLock(this.#db, organisationId, conn);
			const batch = lock.batch;
			await batch((tx) => audit(tx, { organisationId, actor: { kind: 'system' }, action: 'mail.sync_started', subjectType: 'connection', subjectId: conn.id,
				detail: { success: false, error: 'Mail sync has not finished. Saved mail may be incomplete; check again shortly.' } }));
			const token = await this.#connections.accessToken(undefined, organisationId, conn.id);
			const heartbeat = () => batch(async () => {});
			const profile = await this.#gmail.profile(token); await heartbeat(); if (profile.emailAddress !== conn.accountEmail) throw new GmailError();
			const labels = await this.#gmail.labels(token); await heartbeat();
			const previous = lock.previous ? cursorSchema.parse(JSON.parse(lock.previous)) : null;
			let full = !previous || previous.accountEmail !== profile.emailAddress; let historyId = profile.historyId;
			let capped = previous?.capped ?? false; const ids = new Set<string>();
			if (!full) {
				try {
					let pageToken: string | undefined; const pages = new Set<string>();
					do {
						const page = await this.#gmail.history(token, previous!.historyId, pageToken); await heartbeat();
						for (const id of page.threadIds) ids.add(id);
						historyId = page.historyId; pageToken = page.nextPageToken;
						if (ids.size > 5000 || (pageToken && (pages.has(pageToken) || pages.size >= 100))) throw new GmailError();
						if (pageToken) pages.add(pageToken);
					} while (pageToken);
				} catch (error) {
					if (!(error instanceof GmailError && error.status === 404)) throw error;
					full = true; ids.clear(); historyId = profile.historyId;
				}
			}
			if (full) {
				capped = false; let pageToken: string | undefined; const pages = new Set<string>();
				const after = Math.floor((Date.now() - 30 * 86_400_000) / 1000);
				do {
					const page = await this.#gmail.threads(token, after, pageToken); await heartbeat();
					for (const id of page.ids) { if (ids.size >= 500 && !ids.has(id)) { capped = true; break; } ids.add(id); }
					pageToken = page.nextPageToken;
					if (ids.size >= 500) { capped ||= Boolean(pageToken); break; }
					if (pageToken && (pages.has(pageToken) || pages.size >= 100)) throw new GmailError();
					if (pageToken) pages.add(pageToken);
				} while (pageToken);
			}
			counts.full = full; counts.capped = capped;
			const ordered = [...ids];
			for (let offset = 0; offset < ordered.length; offset += 25) {
				const fetched: { id: string; thread: MailThread | null }[] = [];
				for (const id of ordered.slice(offset, offset + 25)) {
					try { fetched.push({ id, thread: await this.#gmail.thread(token, id) }); }
					catch (error) { if (!(error instanceof GmailError && error.status === 404)) throw error; fetched.push({ id, thread: null }); }
					await heartbeat();
				}
				const saved = await batch(async (tx) => {
					const page = { threads: 0, messages: 0, attachments: 0, deleted: 0 };
					for (const { id, thread } of fetched) {
						if (!thread) { page.deleted += (await tx`delete from mail_threads where connection_id = ${conn.id} and provider_id = ${id} returning id`).length; continue; }
						await saveThread(tx, organisationId, conn, thread); page.threads++; page.messages += thread.messages.length;
						page.attachments += thread.messages.reduce((n, m) => n + m.attachments.length, 0);
					}
					const pageIds = fetched.map((t) => t.id);
					await tx`update mail_threads set label_names = array(select coalesce(${tx.json(labels)}::jsonb ->> label, label) from unnest(label_ids) label)
						where connection_id = ${conn.id} and provider_id = any(${tx.array(pageIds)}::text[])`;
					await upkeepContacts(tx, organisationId, conn.accountEmail, pageIds);
					await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'mail.batch_synced', subjectType: 'connection', subjectId: conn.id, detail: { ...page } });
					return page;
				});
				counts.threads += saved.threads; counts.messages += saved.messages; counts.attachments += saved.attachments; counts.deleted += saved.deleted;
			}
			// Backfill unchanged cached contacts, also in bounded batches, including a quiet history run.
			const unchanged = full ? [] : await batch((tx) => tx`select provider_id from mail_threads where connection_id = ${conn.id}
				and account_email = ${conn.accountEmail} and not (provider_id = any(${tx.array(ordered)}::text[]))`);
			if (!full) for (let offset = 0; offset < unchanged.length; offset += 25)
				await batch((tx) => upkeepContacts(tx, organisationId, conn.accountEmail, unchanged.slice(offset, offset + 25).map((t) => t.providerId)));
			const removed = await batch(async (tx) => {
				// Reconcile absent threads only after all fetches succeed; failures retain the prior cache.
				const deleted = full ? (await tx`delete from mail_threads where connection_id = ${conn.id}
					and (account_email <> ${conn.accountEmail} or not (provider_id = any(${tx.array(ordered)}::text[]))) returning id`).length : 0;
				await tx`update mail_threads set label_names = array(select coalesce(${tx.json(labels)}::jsonb ->> label, label) from unnest(label_ids) label)
					where connection_id = ${conn.id}`;
				await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${organisationId}, ${conn.id}, 'gmail.history',
					${JSON.stringify({ accountEmail: conn.accountEmail, historyId, capped })}) on conflict (organisation_id, connection_id, resource)
					do update set cursor = excluded.cursor, updated_at = now()`;
				await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'mail.synced', subjectType: 'connection', subjectId: conn.id, detail: { ...counts, deleted: counts.deleted + deleted, success: true } });
				return deleted;
			});
			counts.deleted += removed;
			return counts;
		} catch (error) {
			if (error instanceof HttpError && error.code === 'sync_running') throw error;
			const message = error instanceof HttpError ? error.message : 'Mail sync did not finish. Saved mail may be incomplete. Try Sync now again; reconnect Google if access has expired.';
			await withTenant(this.#db, { organisationId }, (tx) => audit(tx, { organisationId, actor: { kind: 'system' }, action: 'mail.sync_failed',
				subjectType: 'organisation', subjectId: organisationId, detail: { ...counts, success: false, error: message } }));
			throw new HttpError(503, 'mail_sync_failed', message); // Never log mail or provider errors.
		} finally { try { await lock?.release(); } finally { this.#running.delete(organisationId); } }
	}
}

export function startMailSchedule(sync: Pick<MailSync, 'organisations' | 'run'>, disabled = false, intervalMs = 300_000): () => Promise<void> {
	if (disabled) return async () => {};
	let active: Promise<void> | undefined;
	const tick = () => {
		if (active) return;
		active = (async () => { for (const org of await sync.organisations()) await sync.run(org).catch(() => undefined); })()
			.catch(() => { console.error('[mail] Scheduled sync could not reach its database. Check API database connectivity.'); })
			.finally(() => { active = undefined; });
	};
	const timer = setInterval(tick, intervalMs); timer.unref(); tick();
	return async () => { clearInterval(timer); await active; };
}
