import { awaitStep, boolean, branch, daily, defineWorkflow, each, infer, onEvent, param, read, text, write } from '../definition.ts';

/** Plan §6 example. As mail arrives and each morning: read new threads, classify each, record the
 *  triage, raise suggested tasks, complete duties whose confirmation arrived, keep contacts current;
 *  for threads that need the owner, draft a reply into the outbox and wait for a person to send it;
 *  then label the thread as handled. */
export const inboxTriage = defineWorkflow({
	key: 'inbox-triage', version: 1, name: 'Inbox triage', job: 1,
	description: 'Reads new mail, says what needs you, drafts the replies you would send, and files the rest.',
	triggers: [onEvent('mail.synced'), daily('06:00')],
	parameters: {
		replyStyle: text('A short note on how replies should sound, with up to three example replies.', { maxLength: 4000 }),
		draftReplies: boolean('Draft replies for threads that need you.', true)
	},
	steps: [
		read('gmail.newThreads', { as: 'threads' }),
		each('threads', [
			read('attachments.extractText', { args: { thread: { ref: 'item' }, allow: ['application/pdf', 'text/csv', 'text/plain'], maxBytes: 5_000_000 }, as: 'attachments' }),
			infer('classifyThread', { schema: 'triage', tier: 'small', args: { thread: { ref: 'item' }, attachments: { ref: 'attachments' } }, as: 'triage' }),
			write('triage.record', { args: { thread: { ref: 'item' }, triage: { ref: 'triage' } } }),
			write('tasks.suggestFromTriage', { args: { thread: { ref: 'item' }, triage: { ref: 'triage' } } }),
			write('tasks.completeFromConfirmations', { args: { thread: { ref: 'item' }, triage: { ref: 'triage' } } }),
			write('contacts.upsertFromTriage', { args: { thread: { ref: 'item' }, triage: { ref: 'triage' } } }),
			branch({ and: [{ truthy: 'triage.needsOwner' }, { param: 'draftReplies' }] }, [
				infer('draftReply', { schema: 'draft', tier: 'large', args: { thread: { ref: 'item' }, triage: { ref: 'triage' }, style: param('replyStyle') }, as: 'draft' }),
				write('outbox.create', { args: { thread: { ref: 'item' }, draft: { ref: 'draft' } }, as: 'outboxDraft' }),
				awaitStep('outbox.sent', { args: { draft: { ref: 'outboxDraft' } }, timeoutDays: 7 })
			]),
			write('gmail.label', { args: { thread: { ref: 'item' }, label: 'Captain/Handled' } })
		])
	]
});
