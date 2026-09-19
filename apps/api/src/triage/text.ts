/** A message's own words (plan §14, trimmed input): the text before any quoted reply block or
 *  forwarded header, without quoted lines, and without the signature. Deterministic; no model. */
const quoteIntro = [
	/^On .{1,300}wrote:\s*$/i,               // On Tue, 3 Sep 2026 at 10:12, Jo <jo@x> wrote:
	/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i,
	/^_{6,}\s*$/,                             // Outlook's rule
	/^From:\s.+$/i,                           // a pasted header block (From:, then Sent:/Date:/To:)
	/^Sent from my /i,
	/^Le .{1,300}a écrit\s*:$/i
];
const signOff = /^(kind regards|warm regards|best regards|regards|best wishes|best|cheers|thanks|thank you|many thanks|sincerely|yours sincerely|yours faithfully|ta|cheers mate)[,.!]?\s*$/i;

export function ownText(body: string): string {
	const lines = body.replace(/\r\n?/g, '\n').split('\n');
	const kept: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!; const trimmed = line.trim();
		if (trimmed.startsWith('>')) continue;
		if (quoteIntro.some((rule) => rule.test(trimmed))) {
			// "From:" alone can be prose; treat it as a header block only when a header line follows it.
			if (/^From:\s/i.test(trimmed) && !lines.slice(i + 1, i + 4).some((l) => /^(Sent|Date|To|Subject):\s/i.test(l.trim()))) { kept.push(line); continue; }
			break;
		}
		if (trimmed === '--' || trimmed === '-- ') break;
		if (signOff.test(trimmed) && kept.some((l) => l.trim())) break;
		kept.push(line);
	}
	return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The latest message keeps its own text to the existing cap; earlier ones keep 500 characters. */
export const trimmedMessages = <M extends { body: string }>(messages: M[], latestCap = 20000, earlierCap = 500): M[] =>
	messages.map((m, i) => ({ ...m, body: ownText(m.body).slice(0, i === messages.length - 1 ? latestCap : earlierCap) }));
