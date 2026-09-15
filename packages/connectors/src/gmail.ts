export class GmailError extends Error {
	readonly status: number;
	constructor(status = 0) { super('Gmail could not be read'); this.status = status; }
}
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GmailError(); return value as ObjectValue; };
const string = (value: unknown): string => { if (typeof value !== 'string') throw new GmailError(); return value; };
const array = (value: unknown): unknown[] => { if (value === undefined) return []; if (!Array.isArray(value)) throw new GmailError(); return value; };
const strings = (value: unknown) => array(value).map(string);
const optional = (value: unknown) => value === undefined ? undefined : string(value);
const id = (value: unknown) => { const result = string(value); if (!result) throw new GmailError(); return result; };
export type MailAttachment = { partId: string; filename: string; mediaType: string; size: number; providerAttachmentId: string | null };
export type MailMessage = { providerId: string; fromHeader: string; toHeader: string; ccHeader: string; subject: string; dateHeader: string;
	sentAt: string; snippet: string; labelIds: string[]; inReplyTo: string; body: string; bodyUnavailable: boolean; attachments: MailAttachment[] };
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
	for (const value of array(part.headers)) { const h = object(value); const name = string(h.name).toLowerCase(); result[name] = [result[name], string(h.value)].filter(Boolean).join(', '); }
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
		let decoded: string; try { decoded = new TextDecoder(charset).decode(Buffer.from(data, 'base64url')); } catch { throw new GmailError(); }
		return mime === 'text/html' ? htmlToText(decoded) : decoded;
	}
	const internalDate = string(m.internalDate); if (!/^\d+$/.test(internalDate)) throw new GmailError();
	const sent = new Date(Number(internalDate)); if (!Number.isFinite(sent.getTime())) throw new GmailError();
	const text = body(payload, '0', 0);
	return { providerId: id(m.id), fromHeader: h.from ?? '', toHeader: h.to ?? '', ccHeader: h.cc ?? '', subject: h.subject ?? '', dateHeader: h.date ?? '',
		sentAt: sent.toISOString(), snippet: optional(m.snippet) ?? '', labelIds: strings(m.labelIds), inReplyTo: h['in-reply-to'] ?? '', body: text, bodyUnavailable: unavailable && !text, attachments };
}

/** First-party Gmail REST client. Responses are validated and errors never contain provider bodies. */
export class GmailClient {
	readonly #fetch: typeof fetch;
	constructor(fetcher: typeof fetch = fetch) { this.#fetch = fetcher; }
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
		const data = await this.get(`threads/${encodeURIComponent(threadId)}`, token, { format: 'full' });
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
	private async get(path: string, token: string, params: Record<string, string> = {}): Promise<ObjectValue> {
		try {
			const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`); url.search = new URLSearchParams(params).toString();
			const response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
			if (!response.ok) throw new GmailError(response.status); return object(await response.json());
		} catch (error) { throw error instanceof GmailError ? error : new GmailError(); }
	}
}
