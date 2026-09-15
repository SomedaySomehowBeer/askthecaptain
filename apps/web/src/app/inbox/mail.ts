export type ThreadSummary = { id: string; fromHeader: string; subject: string; snippet: string; sentAt: string; labelNames: string[]; attachmentCount: number };
export type MailList = { nextBefore: string | null; automaticSyncEnabled: boolean; timezone: string; connection: { status: string; accountEmail: string; error: string | null } | null;
	lastSync: { at: string; detail: { success: boolean; capped?: boolean; error?: string } } | null; threads: ThreadSummary[]; hasMore: boolean };
export type ThreadDetail = { id: string; labelNames: string[]; timezone: string; connectionStatus: string; messages: {
	id: string; fromHeader: string; toHeader: string; ccHeader: string; subject: string; sentAt: string; body: string; bodyUnavailable: boolean;
	attachments: { id: string; filename: string; mediaType: string; size: number }[] }[] };
export const mailTime = (date: string, timeZone: string) => new Intl.DateTimeFormat('en-AU', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
export const mailDay = (date: string, timeZone: string) => new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(date));
export const attachmentsInWords = (count: number) => count === 1 ? '1 attachment' : `${count} attachments`;
