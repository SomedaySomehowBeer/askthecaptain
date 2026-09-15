/** The public mailbox domains live here so sync never invents a company for them. */
export const publicDomains = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'yahoo.com', 'yahoo.com.au', 'yahoo.co.uk',
 'icloud.com', 'live.com', 'live.com.au', 'me.com', 'bigpond.com', 'bigpond.net.au', 'optusnet.com.au']);
export type Address = { email: string; name: string };
function displayName(raw: string): string {
 return raw.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (word, charset: string, encoding: string, data: string) => {
  try {
   const bytes = encoding.toLowerCase() === 'b' ? Buffer.from(data, 'base64')
    : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
   return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch { return word; }
 }).trim().replace(/^"(.*)"$/, '$1').replace(/\\(["\\])/g, '$1').replace(/[\r\n\t]+/g, ' ').slice(0, 200);
}
/** Parse mailbox lists without splitting quoted commas or comments. Invalid addresses are ignored.
 * This is header data only: no DNS, network lookups or model calls. */
export function addresses(header: string): Address[] {
 const chunks: string[] = []; let chunk = ''; let quoted = false; let escaped = false; let comment = 0; let angle = false;
 for (const char of header) {
  if (escaped) { if (!comment) chunk += char; escaped = false; continue; }
  if (char === '\\') { escaped = true; if (!comment) chunk += char; continue; }
  if (char === '"' && !comment) quoted = !quoted;
  if (!quoted && char === '(') { comment++; continue; }
  if (!quoted && char === ')' && comment) { comment--; continue; }
  if (comment) continue;
  if (!quoted && char === '<') angle = true;
  if (!quoted && char === '>') angle = false;
  if (!quoted && !angle && char === ':') { chunk = ''; continue; } // group label
  if (!quoted && !angle && (char === ',' || char === ';')) { chunks.push(chunk); chunk = ''; } else chunk += char;
 }
 chunks.push(chunk);
 const result = new Map<string, Address>();
 for (const part of chunks) {
  const match = /^(.*?)<([^<>]+)>\s*$/.exec(part.trim()); const email = (match?.[2] ?? part).trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) continue;
  const name = match ? displayName(match[1]!) : '';
  if (name || !result.has(email)) result.set(email, { email, name });
 }
 return [...result.values()];
}
export const isCounterparty = (email: string, own: string) => email !== own.toLowerCase()
 && !/(?:noreply|no-reply|donotreply|mailer-daemon)/i.test(email.split('@')[0]!) && !email.startsWith('notifications@');
