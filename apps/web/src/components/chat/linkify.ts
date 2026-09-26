/** Plain-text message bodies with web addresses made clickable on display only (contract §5): the stored text is never
 *  changed, nothing but http(s) becomes a link, and every part is rendered as text, never as HTML. */
export type BodyPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string };

const candidate = /\bhttps?:\/\/[^\s<>"']+/gi;
/** Sentence punctuation that usually ends a sentence rather than a URL. A closing bracket stays when the URL opened one. */
const trailing = /[.,;:!?'"\]]+$/;

export function linkify(body: string): BodyPart[] {
	const parts: BodyPart[] = [];
	let at = 0;
	for (const match of body.matchAll(candidate)) {
		let text = match[0];
		const start = match.index ?? 0;
		text = text.replace(trailing, '');
		while (text.endsWith(')') && (text.match(/\(/g)?.length ?? 0) < (text.match(/\)/g)?.length ?? 0)) text = text.slice(0, -1);
		const href = safeHref(text);
		if (!href) continue;
		if (start > at) parts.push({ kind: 'text', text: body.slice(at, start) });
		parts.push({ kind: 'link', text, href });
		at = start + text.length;
	}
	if (at < body.length) parts.push({ kind: 'text', text: body.slice(at) });
	return parts;
}

function safeHref(text: string): string | null {
	try {
		const url = new URL(text);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	} catch { return null; }
}
