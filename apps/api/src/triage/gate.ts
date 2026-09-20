/** The triage gate (plan §14, D20): deterministic code decides, before any model call, whether a
 *  thread needs one. Pure over the signals `gmail.newThreads` collects and the sender's prior. */
export type Signals = {
	/** Gmail label ids on the latest incoming message. */
	labelIds: string[];
	listUnsubscribe: boolean; listId: string; precedence: string; autoSubmitted: string;
	/** The latest incoming sender's address, lower-case. */
	sender: string;
	/** A hand-kept contact, a Xero contact or Shopify customer, or prior sent mail to them. */
	knownSender: boolean;
	/** A person starred any message in the thread. */
	starred: boolean;
	/** When the latest incoming message was sent (ISO 8601). */
	latestAt: string;
	/** A message from the mailbox itself follows the latest incoming one. */
	repliedByOwner: boolean;
};
export type Prior = { threadsSeen: number; informationVerdicts: number; needsOwnerCount: number; replies: number; stars: number };
export type Rule = 'category_promotions' | 'category_social' | 'category_forums' | 'list_header' | 'precedence_bulk' | 'auto_submitted' | 'automated_sender' | 'sender_prior' | 'category_updates_unknown';
export type Verdict = { passes: true; rule: null } | { passes: false; rule: Rule };

const automatedLocalParts = new Set(['noreply', 'notifications', 'mailerdaemon']);
export const localPart = (email: string) => email.split('@')[0]?.split('+')[0]?.replace(/[-_.]/g, '').toLowerCase() ?? '';

export function gate(signals: Signals, prior: Prior | null): Verdict {
	const filed = (rule: Rule): Verdict => ({ passes: false, rule });
	const labels = new Set(signals.labelIds);
	if (labels.has('CATEGORY_PROMOTIONS')) return filed('category_promotions');
	if (labels.has('CATEGORY_SOCIAL')) return filed('category_social');
	if (labels.has('CATEGORY_FORUMS')) return filed('category_forums');
	if (signals.listUnsubscribe || signals.listId) return filed('list_header');
	if (['bulk', 'list', 'junk'].includes(signals.precedence)) return filed('precedence_bulk');
	if (signals.autoSubmitted && signals.autoSubmitted !== 'no') return filed('auto_submitted');
	if (automatedLocalParts.has(localPart(signals.sender))) return filed('automated_sender');
	// A reply or a star from a person resets the sender: their prior no longer files anything.
	const reset = signals.starred || (prior?.replies ?? 0) > 0 || (prior?.stars ?? 0) > 0;
	if (!reset && prior && prior.informationVerdicts >= 3 && prior.needsOwnerCount === 0) return filed('sender_prior');
	if (labels.has('CATEGORY_UPDATES') && !signals.knownSender && !reset) return filed('category_updates_unknown');
	return { passes: true, rule: null };
}

/** Whether a reply is worth drafting, decided by rules before the large model is asked (plan §6). A thread the
 *  owner already answered needs no draft; nor does one whose latest message is more than a day old by the time
 *  the run reaches it, which is the first run's backlog and any long gap in syncing. */
export type DraftingReason = 'already_replied' | 'older_than_a_day';
export type Drafting = { drafts: true; reason: null } | { drafts: false; reason: DraftingReason };
export function drafting(signals: Pick<Signals, 'latestAt' | 'repliedByOwner'>, now: number = Date.now()): Drafting {
	if (signals.repliedByOwner) return { drafts: false, reason: 'already_replied' };
	const sent = Date.parse(signals.latestAt);
	if (!Number.isFinite(sent) || now - sent > 24 * 60 * 60 * 1000) return { drafts: false, reason: 'older_than_a_day' };
	return { drafts: true, reason: null };
}
export const draftingWords: Record<DraftingReason, string> = {
	already_replied: 'You have already replied to it.',
	older_than_a_day: 'Its latest message is more than a day old, so a drafted reply would come too late.'
};

/** The rule in the person's words, for the Inbox and the journal. */
export const ruleWords: Record<Rule, string> = {
	category_promotions: 'Gmail put it in Promotions.',
	category_social: 'Gmail put it in Social.',
	category_forums: 'Gmail put it in Forums.',
	list_header: 'It came from a mailing list.',
	precedence_bulk: 'It was sent as bulk mail.',
	auto_submitted: 'It was sent by a machine, not a person.',
	automated_sender: 'It came from a no-reply or notifications address.',
	sender_prior: 'Everything from this sender so far has been information only, and nobody has replied to or starred them.',
	category_updates_unknown: 'Gmail put it in Updates and the sender is not someone you know.'
};
