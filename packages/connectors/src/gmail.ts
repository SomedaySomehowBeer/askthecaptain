/** Google's documented error reasons; anything else is dropped so provider text never travels. */
export const googleReasons = new Set(['accessNotConfigured', 'insufficientPermissions', 'forbidden', 'domainPolicy', 'dailyLimitExceeded',
	'userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded', 'notFound', 'failedPrecondition', 'invalidArgument', 'backendError', 'authError',
	'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'NOT_FOUND', 'FAILED_PRECONDITION', 'INVALID_ARGUMENT', 'UNAVAILABLE', 'INTERNAL']);
/** Read the reason from a Google error body without keeping any of its text. */
export async function googleReason(response: Response): Promise<string> {
	try {
		const body = await response.json(); const error = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
		if (!error || typeof error !== 'object') return '';
		const details = error as { errors?: unknown; status?: unknown }; const first: unknown = Array.isArray(details.errors) ? details.errors[0] : undefined;
		const reason = first && typeof first === 'object' ? (first as { reason?: unknown }).reason : undefined;
		for (const candidate of [reason, details.status]) if (typeof candidate === 'string' && googleReasons.has(candidate)) return candidate;
		return '';
	} catch { return ''; }
}
/** Names a failed fetch without its content: `timeout`, `network`, or `unreadable` for a response Captain could not parse. */
export function fetchReason(error: unknown): string {
	const name = error instanceof Error ? error.name : '';
	return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name === 'TypeError' ? 'network' : 'unreadable';
}
/** Google's documented answer to `403 rateLimitExceeded` / `429` is exponential backoff. A limited
 * request was not executed, so retrying it is safe even for a send. */
export const retryableReasons = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'RESOURCE_EXHAUSTED']);
export type GoogleClientOptions = { sleep?: (ms: number) => Promise<void>; retries?: number };
export const backoffMs = (attempt: number) => Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
export const shouldRetry = (status: number, reason: string, method: 'GET' | 'POST') =>
	status === 429 || (status === 403 && retryableReasons.has(reason)) || (method === 'GET' && status >= 500 && status < 600 && reason !== 'unreadable' && reason !== 'timeout' && reason !== 'network');
export class GmailError extends Error {
	readonly status: number; readonly reason: string;
	/** `status` 0 means Gmail never answered usably; `reason` is a Google reason or Captain's own short word. */
	constructor(status = 0, reason = status ? '' : 'unreadable') { super('Gmail could not be read'); this.status = status; this.reason = reason; }
}
const strip = (value: string) => value.replaceAll('\u0000', ''); // Postgres text cannot hold NUL; mail occasionally does.
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GmailError(); return value as ObjectValue; };
const string = (value: unknown): string => { if (typeof value !== 'string') throw new GmailError(); return value; };
const array = (value: unknown): unknown[] => { if (value === undefined) return []; if (!Array.isArray(value)) throw new GmailError(); return value; };
const strings = (value: unknown) => array(value).map(string);
const optional = (value: unknown) => value === undefined ? undefined : string(value);
const id = (value: unknown) => { const result = string(value); if (!result) throw new GmailError(); return result; };
export type MailAttachment = { partId: string; filename: string; mediaType: string; size: number; providerAttachmentId: string | null };
export type MailMessage = { providerId: string; fromHeader: string; toHeader: string; ccHeader: string; bccHeader: string; subject: string; dateHeader: string;
	rfcMessageId?: string; sentAt: string; snippet: string; labelIds: string[]; inReplyTo: string; body: string; bodyUnavailable: boolean; attachments: MailAttachment[] };
export type MailThread = { providerId: string; messages: MailMessage[] };
export type HistoryPage = { threadIds: string[]; historyId: string; nextPageToken?: string };

/** Mail is rendered only as text. This conversion is deliberately not an HTML sanitizer. */
export function htmlToText(html: string): string {
	const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
	return html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style|head)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
		.replace(/<(?:br\b[^>]*|\/(?:p|div|li|tr|h[1-6]))\s*>/gi, '\n').replace(/<[^>]*>/g, '')
		.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity: string) => {
			if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? whole;
			const n = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
			return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
		}).replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function headers(part: ObjectValue): Record<string, string> {
	const result: Record<string, string> = Object.create(null);
	for (const value of array(part.headers)) { const h = object(value); const name = string(h.name).toLowerCase(); result[name] = [result[name], strip(string(h.value))].filter(Boolean).join(', '); }
	return result;
}
function parseMessage(value: unknown): MailMessage {
	const m = object(value); const payload = object(m.payload); const h = headers(payload); const attachments: MailAttachment[] = [];
	let unavailable = false; let parts = 0;
	function body(part: ObjectValue, path: string, depth: number): string {
		if (++parts > 1000 || depth > 30) throw new GmailError();
		const mime = string(part.mimeType).toLowerCase(); const filename = optional(part.filename) ?? ''; const bytes = object(part.body ?? {});
		const ph = headers(part); const isText = mime === 'text/plain' || mime === 'text/html';
		if (filename || /^attachment\b/i.test(ph['content-disposition'] ?? '') || (!isText && !mime.startsWith('multipart/'))) {
			if (typeof bytes.size !== 'number' || !Number.isSafeInteger(bytes.size) || bytes.size < 0) throw new GmailError();
			attachments.push({ partId: optional(part.partId) ?? path, filename, mediaType: mime, size: bytes.size, providerAttachmentId: optional(bytes.attachmentId) ?? null });
			return ''; // Never decode attachment data and never call messages.attachments.get.
		}
		const children = array(part.parts).map(object);
		if (mime === 'multipart/alternative') {
			// Prefer plain text, retaining metadata from every alternative without duplicating bodies.
			const rendered = children.map((child, i) => ({ mime: child.mimeType, text: body(child, `${path}.${i}`, depth + 1) }));
			return rendered.find((p) => p.mime === 'text/plain' && p.text)?.text ?? rendered.find((p) => p.text)?.text ?? '';
		}
		if (children.length) return children.map((child, i) => body(child, `${path}.${i}`, depth + 1)).filter(Boolean).join('\n\n');
		if (!isText) return '';
		if (bytes.attachmentId && !bytes.data) { unavailable = true; return ''; }
		const data = optional(bytes.data) ?? ''; if (!/^[\w-]*={0,2}$/.test(data)) throw new GmailError();
		const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(ph['content-type'] ?? '')?.[1] ?? 'utf-8';
		// A charset this runtime does not know must not stop the whole mailbox: read the part as UTF-8 instead.
		let decoder: TextDecoder; try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
		const decoded = strip(decoder.decode(Buffer.from(data, 'base64url')));
		return mime === 'text/html' ? htmlToText(decoded) : decoded;
	}
	const internalDate = string(m.internalDate); if (!/^\d+$/.test(internalDate)) throw new GmailError();
	const sent = new Date(Number(internalDate)); if (!Number.isFinite(sent.getTime())) throw new GmailError();
	const text = body(payload, '0', 0);
	return { providerId: id(m.id), fromHeader: h.from ?? '', toHeader: h.to ?? '', ccHeader: h.cc ?? '', bccHeader: h.bcc ?? '', subject: h.subject ?? '', dateHeader: h.date ?? '',
		rfcMessageId: h['message-id'] ?? '', sentAt: sent.toISOString(), snippet: strip(optional(m.snippet) ?? ''), labelIds: strings(m.labelIds), inReplyTo: h['in-reply-to'] ?? '', body: text, bodyUnavailable: unavailable && !text, attachments };
}

/** First-party Gmail REST client. Responses are validated and errors never contain provider bodies. */
export class GmailClient {
	readonly #fetch: typeof fetch; readonly #sleep: (ms: number) => Promise<void>; readonly #retries: number;
	constructor(fetcher: typeof fetch = fetch, options: GoogleClientOptions = {}) {
		this.#fetch = fetcher; this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))); this.#retries = options.retries ?? 4;
	}
	async profile(token: string): Promise<{ emailAddress: string; historyId: string }> {
		const data = await this.get('profile', token); return { emailAddress: id(data.emailAddress).toLowerCase(), historyId: id(data.historyId) };
	}
	async labels(token: string): Promise<Record<string, string>> {
		const data = await this.get('labels', token); return Object.fromEntries(array(data.labels).map((v) => { const label = object(v); return [id(label.id), string(label.name)]; }));
	}
	async threads(token: string, after: number, pageToken?: string): Promise<{ ids: string[]; nextPageToken?: string }> {
		const data = await this.get('threads', token, { q: `after:${after}`, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
		return { ids: array(data.threads).map((v) => id(object(v).id)), nextPageToken: optional(data.nextPageToken) };
	}
	async thread(token: string, threadId: string): Promise<MailThread> {
		const data = await this.get(`threads/${encodeURIComponent(threadId)}`, token, { format: 'full' }, 30_000); // Long threads arrive whole.
		const messages = array(data.messages).map(parseMessage).sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.providerId.localeCompare(b.providerId));
		if (id(data.id) !== threadId || !messages.length || new Set(messages.map((m) => m.providerId)).size !== messages.length) throw new GmailError();
		return { providerId: threadId, messages };
	}
	async history(token: string, startHistoryId: string, pageToken?: string): Promise<HistoryPage> {
		const data = await this.get('history', token, { startHistoryId, maxResults: '500', ...(pageToken ? { pageToken } : {}) }); const ids = new Set<string>();
		for (const value of array(data.history)) {
			const entry = object(value); const messages = [...array(entry.messages)];
			for (const key of ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved']) for (const item of array(entry[key])) messages.push(object(item).message);
			for (const message of messages) ids.add(id(object(message).threadId));
		}
		return { threadIds: [...ids], historyId: id(data.historyId), nextPageToken: optional(data.nextPageToken) };
	}
	async watch(token: string, topicName: string): Promise<{ historyId: string; expiration: number }> {
		const data = await this.post('watch', token, { topicName });
		const expiration = Number(id(data.expiration)); if (!Number.isSafeInteger(expiration) || expiration <= 0) throw new GmailError();
		return { historyId: id(data.historyId), expiration };
	}
	async attachment(token: string, messageId: string, attachmentId: string, maxBytes = 5_000_000): Promise<string> {
		const data = await this.get(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, token);
		const encoded = string(data.data);
		if (typeof data.size !== 'number' || data.size > maxBytes || encoded.length > Math.ceil(maxBytes / 3) * 4 || !/^[\w-]*={0,2}$/.test(encoded)) throw new GmailError();
		const bytes = Buffer.from(encoded, 'base64url'); if (bytes.length > maxBytes) throw new GmailError();
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\u0000', '').slice(0, 20000);
	}
	async label(token: string, threadId: string, name: string): Promise<void> {
		let labels = await this.labels(token); let labelId = Object.keys(labels).find(key => labels[key] === name);
		if (!labelId) {
			try { labelId = id((await this.post('labels', token, { name })).id); }
			catch (error) { labels = await this.labels(token); labelId = Object.keys(labels).find(key => labels[key] === name); if (!labelId) throw error; }
		}
		await this.post(`threads/${encodeURIComponent(threadId)}/modify`, token, { addLabelIds: [labelId] });
	}
	async send(token: string, raw: string, threadId?: string): Promise<string> {
		return id((await this.post('messages/send', token, { raw, ...(threadId ? { threadId } : {}) })).id);
	}
	async sentMessage(token: string, messageId: string): Promise<string | null> {
		const data = await this.get('messages', token, { q: `in:sent rfc822msgid:${messageId}`, maxResults: '2' });
		const rows = array(data.messages); if (rows.length > 1) throw new GmailError();
		return rows.length ? id(object(rows[0]).id) : null;
	}
	async stop(token: string): Promise<void> { await this.post('stop', token); }
	private async post(path: string, token: string, body?: object): Promise<ObjectValue> {
		return this.attempt('POST', async () => {
			const response = await this.#fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { method: 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000) });
			if (!response.ok) throw new GmailError(response.status, await googleReason(response)); return path === 'stop' ? {} : object(await response.json());
		});
	}

	private async get(path: string, token: string, params: Record<string, string> = {}, timeoutMs = 15_000): Promise<ObjectValue> {
		return this.attempt('GET', async () => {
			const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`); url.search = new URLSearchParams(params).toString();
			const response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
			if (!response.ok) throw new GmailError(response.status, await googleReason(response)); return object(await response.json());
		});
	}
	private async attempt(method: 'GET' | 'POST', request: () => Promise<ObjectValue>): Promise<ObjectValue> {
		for (let n = 0; ; n++) {
			try { return await request(); }
			catch (error) {
				const failure = error instanceof GmailError ? error : new GmailError(0, fetchReason(error));
				if (n >= this.#retries || !shouldRetry(failure.status, failure.reason, method)) throw failure;
				await this.#sleep(backoffMs(n));
			}
		}
	}
}
