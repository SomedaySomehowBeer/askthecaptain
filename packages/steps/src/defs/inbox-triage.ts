import { awaitStep, boolean, branch, daily, defineWorkflow, each, infer, number, onEvent, param, read, text, write } from '../definition.ts';

/** Plan §6. As mail arrives and each morning: read new threads; gate each with rules and sender
 *  priors (D20), filing bulk and automated mail without a model call; classify the rest, record the
 *  triage, raise suggested tasks, complete duties whose confirmation arrived; for threads that need
 *  the owner and whose draft score reaches the threshold (fresh, unanswered, a request or a familiar
 *  sender, past drafts to them used), draft a reply into the outbox and wait for a person to send it;
 *  the backlog on a first run gets no drafts and a run drafts at most twenty; keep contacts current
 *  and label the thread as handled either way. */
export const inboxTriage = defineWorkflow({
	key: 'inbox-triage', version: 4, name: 'Inbox triage', job: 1,
	description: 'Reads new mail, says what needs you, drafts the replies you would send, and files the rest.',
	triggers: [onEvent('mail.synced'), daily('06:00')],
	parameters: {
		replyStyle: text('Optional. A short note on how replies should sound, with up to three example replies. Left blank, drafts follow the voice of your own messages in the thread.', { maxLength: 4000 }),
		draftReplies: boolean('Draft replies for threads that need you.', true),
		draftThreshold: number('Draft score a thread must reach for a reply to be drafted. 3 means: needs you, and a request or a sender you know. Lower drafts more, higher fewer.', 3, { min: 0, max: 10, integer: true })
	},
	steps: [
		read('gmail.newThreads', { as: 'threads' }),
		each('threads', [
			read('triage.gate', { args: { thread: { ref: 'item' } }, as: 'gate' }),
			branch({ truthy: 'gate.passes' }, [
				read('attachments.extractText', { args: { thread: { ref: 'item' }, allow: ['application/pdf', 'text/csv', 'text/plain'], maxBytes: 5_000_000 }, as: 'attachments' }),
				infer('classifyThread', { schema: 'triage', tier: 'small', args: { thread: { ref: 'item' }, attachments: { ref: 'attachments' } }, as: 'triage' }),
				write('triage.record', { args: { thread: { ref: 'item' }, triage: { ref: 'triage' } } }),
				write('tasks.suggestFromTriage', { args: { thread: { ref: 'item' }, triage: { ref: 'triage' } } }),
				write('tasks.completeFromConfirmations', { args: { thread: { ref: 'item' }, triage: { ref: 'triage' } } }),
				read('triage.draftScore', { args: { thread: { ref: 'item' }, triage: { ref: 'triage' }, threshold: param('draftThreshold') }, as: 'drafting' }),
				branch({ and: [{ param: 'draftReplies' }, { truthy: 'drafting.drafts' }] }, [
					infer('draftReply', { schema: 'draft', tier: 'large', args: { thread: { ref: 'item' }, triage: { ref: 'triage' }, style: param('replyStyle') }, as: 'draft' }),
					write('outbox.create', { args: { thread: { ref: 'item' }, draft: { ref: 'draft' } }, as: 'outboxDraft' }),
					awaitStep('outbox.sent', { args: { draft: { ref: 'outboxDraft' } }, timeoutDays: 60 })
				])
			], [
				write('triage.file', { args: { thread: { ref: 'item' }, gate: { ref: 'gate' } } })
			]),
			write('contacts.upsertFromTriage', { args: { thread: { ref: 'item' } } }),
			write('gmail.label', { args: { thread: { ref: 'item' }, label: 'Captain/Handled' } })
		])
	]
});
