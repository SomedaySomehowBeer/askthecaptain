/** Embedding units (plan: the index). Deterministic text rules; the encoder sees the result. Token
 *  counts are estimates at four characters a token, which is all the rules need. */
export const CHARS_PER_TOKEN = 4;
export const tokens = (text: string): number => Math.ceil(text.trim().length / CHARS_PER_TOKEN);
export const PARENT_CONTEXT_TOKENS = 200;
export const MIN_OWN_TOKENS = 40;
export const CHUNK_TOKENS = 256;
export const THREAD_WEIGHT_TOKENS = 300;
const clip = (text: string, maxTokens: number) => text.length <= maxTokens * CHARS_PER_TOKEN ? text : text.slice(0, maxTokens * CHARS_PER_TOKEN).replace(/\s+\S*$/, '');
export type MessageUnitInput = {
	subject: string;
	/** The message's own words, quoted blocks and signature removed. */
	ownText: string;
	/** The parent's own words when the parent is stored, else the message's quoted block, else nothing. */
	parentText?: string;
	quotedText?: string;
};
export type MessageUnit = { text: string; ownTokens: number; inherit: boolean };
/** Subject, then the parent's text to about 200 tokens (the quoted block standing in when the parent is not
 *  stored), then the message's own text. Fewer than about 40 tokens of own text means the message's meaning is
 *  the parent plus a yes or a no: it gets no vector of its own and inherits the parent's. */
export function messageUnit(input: MessageUnitInput): MessageUnit {
	const own = input.ownText.trim(); const ownTokens = tokens(own);
	const context = clip((input.parentText ?? input.quotedText ?? '').trim(), PARENT_CONTEXT_TOKENS);
	const text = [input.subject.trim(), context, own].filter((part) => part.length > 0).join('\n\n');
	return { text, ownTokens, inherit: ownTokens < MIN_OWN_TOKENS && Boolean(input.parentText) };
}
export type NoteUnitInput = { title: string; body: string; linked?: string[] };
/** Title or first line, then the names of what the note is linked to, then the body. */
export function noteUnit(input: NoteUnitInput): { text: string; tokens: number } {
	const body = input.body.trim(); const title = input.title.trim() || body.split('\n')[0]!.trim();
	const linked = (input.linked ?? []).map((name) => name.trim()).filter(Boolean).join(' · ');
	return { text: [title, linked, body].filter((part) => part.length > 0).join('\n\n'), tokens: tokens(body) };
}
/** Longer units are chunked at about 256 tokens on paragraph, then sentence, then word boundaries. */
export function chunk(text: string, maxTokens = CHUNK_TOKENS): string[] {
	const max = maxTokens * CHARS_PER_TOKEN; const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed.length ? [trimmed] : [];
	const pieces: string[] = []; let current = '';
	const push = (part: string) => {
		if (!part) return;
		if (current.length + part.length + 1 <= max) { current = current ? `${current}\n${part}` : part; return; }
		if (current) pieces.push(current);
		if (part.length <= max) { current = part; return; }
		// A paragraph longer than a chunk splits on sentence ends, then on words.
		let rest = part;
		while (rest.length > max) {
			const window = rest.slice(0, max); const at = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '), window.lastIndexOf(' '));
			const cut = at > max / 2 ? at + 1 : max;
			pieces.push(rest.slice(0, cut).trim()); rest = rest.slice(cut).trim();
		}
		current = rest;
	};
	for (const paragraph of trimmed.split(/\n\s*\n/)) push(paragraph.trim());
	if (current) pieces.push(current);
	return pieces.filter((piece) => piece.length > 0);
}
/** The quoted block of a body: lines from the first quote introduction or `>` line onwards, unquoted. */
export function quotedText(body: string): string {
	const lines = body.replace(/\r\n?/g, '\n').split('\n');
	const start = lines.findIndex((line) => /^\s*>/.test(line) || /^On .{1,300}wrote:\s*$/i.test(line.trim()) || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(line.trim()));
	if (start < 0) return '';
	return lines.slice(start).map((line) => line.replace(/^\s*(>\s?)+/, '')).filter((line) => !/^On .{1,300}wrote:\s*$/i.test(line.trim())).join('\n').trim();
}
