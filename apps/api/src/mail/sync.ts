import { upkeepContacts } from '../contacts/upkeep.ts';
import { GmailClient, GmailError } from '@captain/connectors/gmail';
import { withTenant, type Sql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import type { ConnectionService } from '../connections/service.ts';
import { badRequest, HttpError } from '../errors.ts';
import { connection, saveThread } from './store.ts';
const cursorSchema = z.object({ accountEmail: z.string(), historyId: z.string().min(1), capped: z.boolean() });
export type SyncResult = { threads: number; messages: number; attachments: number; deleted: number; full: boolean; capped: boolean };

/** Housekeeping, never a workflow. Cursor and mail changes commit together; any failure can retry.
 * TODO: Gmail Pub/Sub webhook push, verification and history-triggered sync in a later PR. */
export class MailSync {
	readonly #running = new Set<string>(); readonly #db: Sql; readonly #connections: ConnectionService; readonly #gmail: GmailClient;
	constructor(db: Sql, connections: ConnectionService, gmail = new GmailClient()) { this.#db = db; this.#connections = connections; this.#gmail = gmail; }
	async organisations(): Promise<string[]> {
		return (await this.#db<{ organisationId: string }[]>`select organisation_id from gmail_sync_organisations()`).map((row) => row.organisationId);
	}
	async run(organisationId: string): Promise<SyncResult> {
		if (this.#running.has(organisationId)) throw new HttpError(409, 'sync_running', 'Mail sync is already running. Check again shortly.');
		this.#running.add(organisationId);
		try {
			const conn = await withTenant(this.#db, { organisationId }, connection);
			if (!conn || conn.status !== 'connected') throw badRequest('connection_unavailable', 'Connect or reconnect Google in Settings before syncing mail.');
			// Refresh completes under its own connection row lock before taking the sync transaction.
			const token = await this.#connections.accessToken(undefined, organisationId, conn.id);
			return await withTenant(this.#db, { organisationId }, async (tx) => {
				const [lock] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${`gmail.sync:${organisationId}`}, 0)) as acquired`;
				if (!lock!.acquired) throw new HttpError(409, 'sync_running', 'Mail sync is already running. Check again shortly.');
				const profile = await this.#gmail.profile(token); if (profile.emailAddress !== conn.accountEmail) throw new GmailError();
				const labels = await this.#gmail.labels(token);
				const [stored] = await tx`select cursor from sync_cursors where connection_id = ${conn.id} and resource = 'gmail.history'`;
				const previous = stored ? cursorSchema.parse(JSON.parse(stored.cursor)) : null;
				let full = !previous || previous.accountEmail !== profile.emailAddress; let historyId = profile.historyId;
				let capped = previous?.capped ?? false; const ids = new Set<string>();
				if (!full) {
					try {
						let pageToken: string | undefined; const pages = new Set<string>();
						do {
							const page = await this.#gmail.history(token, previous!.historyId, pageToken);
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
						const page = await this.#gmail.threads(token, after, pageToken);
						for (const id of page.ids) { if (ids.size >= 500 && !ids.has(id)) { capped = true; break; } ids.add(id); }
						pageToken = page.nextPageToken;
						if (ids.size >= 500) { capped ||= Boolean(pageToken); break; }
						if (pageToken && (pages.has(pageToken) || pages.size >= 100)) throw new GmailError();
						if (pageToken) pages.add(pageToken);
					} while (pageToken);
				}
				const counts: SyncResult = { threads: 0, messages: 0, attachments: 0, deleted: 0, full, capped };
				// Holding a share lock prevents disconnect/account replacement during persistence. A
				// reconnect that happened while listing must be detected before writing any mail.
				const [current] = await tx`select account_email, status from connections where id = ${conn.id} for share`;
				if (current?.status !== 'connected' || current.accountEmail !== conn.accountEmail) throw new GmailError();
				if (full) counts.deleted += (await tx`delete from mail_threads where connection_id = ${conn.id}
					and (account_email <> ${conn.accountEmail} or not (provider_id = any(${tx.array([...ids])}::text[]))) returning id`).length;
				for (const id of ids) {
					try {
						const thread = await this.#gmail.thread(token, id); await saveThread(tx, organisationId, conn, thread);
						counts.threads++; counts.messages += thread.messages.length; counts.attachments += thread.messages.reduce((n, m) => n + m.attachments.length, 0);
					} catch (error) {
						if (!(error instanceof GmailError && error.status === 404)) throw error;
						counts.deleted += (await tx`delete from mail_threads where connection_id = ${conn.id} and provider_id = ${id} returning id`).length;
					}
				}
				await tx`update mail_threads set label_names = array(select coalesce(${tx.json(labels)}::jsonb ->> label, label) from unnest(label_ids) label)
					where connection_id = ${conn.id}`;
				await tx`insert into sync_cursors (organisation_id, connection_id, resource, cursor) values (${organisationId}, ${conn.id}, 'gmail.history',
					${JSON.stringify({ accountEmail: conn.accountEmail, historyId, capped })}) on conflict (organisation_id, connection_id, resource)
					do update set cursor = excluded.cursor, updated_at = now()`;
				await upkeepContacts(tx, organisationId, conn.accountEmail);
				await audit(tx, { organisationId, actor: { kind: 'system' }, action: 'mail.synced', subjectType: 'connection', subjectId: conn.id, detail: { ...counts, success: true } });
				return counts;
			});
		} catch (error) {
			if (error instanceof HttpError && error.code === 'sync_running') throw error;
			const message = error instanceof HttpError ? error.message : 'Mail could not be synced. Try Sync now again; reconnect Google if access has expired.';
			await withTenant(this.#db, { organisationId }, (tx) => audit(tx, { organisationId, actor: { kind: 'system' }, action: 'mail.sync_failed',
				subjectType: 'organisation', subjectId: organisationId, detail: { success: false, threads: 0, messages: 0, attachments: 0, error: message } }));
			throw new HttpError(503, 'mail_sync_failed', message); // Never log mail or provider errors.
		} finally { this.#running.delete(organisationId); }
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
