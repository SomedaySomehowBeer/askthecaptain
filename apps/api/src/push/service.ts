import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { audit } from '../audit.ts';
import { badRequest, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';

export type Subscription = { id: string; endpoint: string; userAgent: string; createdAt: Date; lastUsedAt: Date | null };
export type Payload = { title: string; body?: string; url?: string; tag?: string };
export type Delivery = { subscriptionId: string; state: 'sent' | 'failed' | 'gone'; statusCode: number | null; error: string | null };

/** The one thing that talks to a push service. `web-push` in production; a stub in tests. */
export interface PushTransport {
	send(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string): Promise<{ statusCode: number }>;
}
export class PushTransportError extends Error { readonly statusCode: number; constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; this.name = 'PushTransportError'; } }

const endpointOk = (value: string) => /^https:\/\/[^\s]+$/.test(value) && value.length <= 2000;

/** Web Push to a person's devices (plan §5 Notifications, §6 notify). Subscriptions belong to a
 *  member; sends are journaled as deliveries whether they succeed or not; a subscription the push
 *  service says is gone is disabled, not retried. Content of a push is the title, a line and a URL
 *  into the app: never mail bodies. */
export class PushService {
	readonly #db: Sql; readonly #transport: PushTransport | null; readonly #publicKey: string | null;
	constructor(db: Sql, transport: PushTransport | null, publicKey: string | null) { this.#db = db; this.#transport = transport; this.#publicKey = publicKey; }

	get configured() { return this.#transport !== null && this.#publicKey !== null; }
	get publicKey() { return this.#publicKey; }

	async subscribe(actor: Actor, organisationId: string, input: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string }): Promise<Subscription> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (!this.configured) throw badRequest('push_unavailable', 'push is not set up on this Captain yet');
		if (!endpointOk(input.endpoint)) throw badRequest('endpoint_invalid', 'that push endpoint is not an https URL');
		if (!input.keys.p256dh || !input.keys.auth) throw badRequest('keys_invalid', 'the subscription keys are missing');
		return withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const [row] = await tx<Subscription[]>`insert into push_subscriptions (organisation_id, user_id, endpoint, p256dh, auth, user_agent)
				values (${organisationId}, ${actor.userId}, ${input.endpoint}, ${input.keys.p256dh}, ${input.keys.auth}, ${(input.userAgent ?? '').slice(0, 300)})
				on conflict (organisation_id, endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
					disabled_at = null, disabled_reason = null
				returning id, endpoint, user_agent, created_at, last_used_at`;
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'push.subscribed', subjectType: 'push_subscription', subjectId: row!.id, requestId: actor.requestId, detail: { userAgent: input.userAgent ?? '' } });
			return row!;
		});
	}

	async unsubscribe(actor: Actor, organisationId: string, endpoint: string): Promise<void> {
		await roleOf(this.#db, actor.userId, organisationId);
		await withTenant(this.#db, { organisationId, userId: actor.userId }, async (tx) => {
			const rows = await tx`update push_subscriptions set disabled_at = now(), disabled_reason = 'removed by the person' where organisation_id = ${organisationId} and user_id = ${actor.userId} and endpoint = ${endpoint} and disabled_at is null returning id`;
			if (!rows.length) throw notFound('that device is not subscribed');
			await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, action: 'push.unsubscribed', subjectType: 'push_subscription', subjectId: rows[0]!.id, requestId: actor.requestId });
		});
	}

	/** The signed-in person's own devices. */
	async mine(actor: Actor, organisationId: string): Promise<Subscription[]> {
		await roleOf(this.#db, actor.userId, organisationId);
		return withTenant(this.#db, { organisationId, userId: actor.userId }, (tx) => tx<Subscription[]>`select id, endpoint, user_agent, created_at, last_used_at from push_subscriptions
			where organisation_id = ${organisationId} and user_id = ${actor.userId} and disabled_at is null order by created_at`);
	}

	/** Whether anyone in the organisation can be pushed to: what a notify step needs. */
	async available(tx: TransactionSql, organisationId: string, userId?: string): Promise<boolean> {
		if (!this.configured) return false;
		const [row] = await tx`select 1 from push_subscriptions where organisation_id = ${organisationId} and disabled_at is null and (${userId ?? null}::uuid is null or user_id = ${userId ?? null}::uuid) limit 1`;
		return Boolean(row);
	}

	/** Push to every live device of one person. Returns a delivery per device; a device the push
	 *  service reports gone (404, 410) is disabled. Never throws for a failed send: the journal says. */
	async send(organisationId: string, userId: string, payload: Payload, options: { runId?: string; actor?: Actor } = {}): Promise<Delivery[]> {
		if (!this.#transport) return [];
		const message = JSON.stringify({ title: payload.title.slice(0, 120), body: (payload.body ?? '').slice(0, 500), url: payload.url ?? '/', tag: payload.tag });
		const devices = await withTenant(this.#db, { organisationId, userId: options.actor?.userId }, (tx) => tx<{ id: string; endpoint: string; p256dh: string; auth: string }[]>`
			select id, endpoint, p256dh, auth from push_subscriptions where organisation_id = ${organisationId} and user_id = ${userId} and disabled_at is null`);
		const deliveries: Delivery[] = [];
		for (const device of devices) {
			let delivery: Delivery;
			try { const result = await this.#transport.send({ endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } }, message); delivery = { subscriptionId: device.id, state: 'sent', statusCode: result.statusCode, error: null }; }
			catch (error) {
				const statusCode = error instanceof PushTransportError ? error.statusCode : null;
				delivery = { subscriptionId: device.id, state: statusCode === 404 || statusCode === 410 ? 'gone' : 'failed', statusCode, error: error instanceof Error ? error.message.slice(0, 300) : 'push failed' };
			}
			await withTenant(this.#db, { organisationId, userId: options.actor?.userId }, async (tx) => {
				await tx`insert into push_deliveries (organisation_id, subscription_id, run_id, title, body, url, state, status_code, error)
					values (${organisationId}, ${device.id}, ${options.runId ?? null}, ${payload.title.slice(0, 120)}, ${(payload.body ?? '').slice(0, 500)}, ${payload.url ?? '/'}, ${delivery.state}, ${delivery.statusCode}, ${delivery.error})`;
				if (delivery.state === 'sent') await tx`update push_subscriptions set last_used_at = now() where id = ${device.id}`;
				if (delivery.state === 'gone') await tx`update push_subscriptions set disabled_at = now(), disabled_reason = 'the push service says this device is gone' where id = ${device.id}`;
			});
			deliveries.push(delivery);
		}
		return deliveries;
	}

	/** A test push to the signed-in person's own devices, from Settings. */
	async test(actor: Actor, organisationId: string): Promise<Delivery[]> {
		await roleOf(this.#db, actor.userId, organisationId);
		if (!this.configured) throw badRequest('push_unavailable', 'push is not set up on this Captain yet');
		const deliveries = await this.send(organisationId, actor.userId, { title: 'Captain can reach this device', body: 'Briefs and reminders will arrive like this.', url: '/settings/notifications', tag: 'test' }, { actor });
		if (deliveries.length === 0) throw badRequest('no_devices', 'this account has no subscribed device');
		return deliveries;
	}
}
