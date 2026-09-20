export type Triage = { category: string; needsOwner: boolean; summary: string; model?: string; remindAt?: string | null; facts: { counterparty: string | null; amounts: string[]; dates: string[]; references: string[] } };
export type Draft = { id: string; threadId: string | null; subject: string; body: string; to: string[]; cc: string[]; state: 'drafted' | 'sent' | 'discarded'; sendStartedAt: string | null; outcome: 'sent' | 'edited_sent' | 'discarded' | 'not_needed' | 'expired' | null; edited: boolean; remindAt: string | null };
export type ThreadSummary = { triage: Triage | null; hasDraft: boolean; id: string; fromHeader: string; subject: string; snippet: string; sentAt: string; labelNames: string[]; attachmentCount: number };
export type MailList = { triageNotice: string | null; outbox: Draft[]; nextBefore: string | null; automaticSyncEnabled: boolean; timezone: string; connection: { status: string; accountEmail: string; error: string | null } | null;
	lastSync: { at: string; detail: { success: boolean; capped?: boolean; error?: string } } | null; threads: ThreadSummary[]; hasMore: boolean };
export type ThreadDetail = { triageNotice: string | null; triage: Triage | null; outbox: Draft[]; id: string; labelNames: string[]; timezone: string; connectionStatus: string; messages: {
	id: string; senderContact: { id: string; name: string; email: string } | null; fromHeader: string; toHeader: string; ccHeader: string; subject: string; sentAt: string; body: string; bodyUnavailable: boolean;
	attachments: { id: string; filename: string; mediaType: string; size: number }[] }[] };
export const mailTime = (date: string, timeZone: string) => new Intl.DateTimeFormat('en-AU', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
export const mailDay = (date: string, timeZone: string) => new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(date));
export const attachmentsInWords = (count: number) => count === 1 ? '1 attachment' : `${count} attachments`;
