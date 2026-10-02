/** The thread tables (migration 0046). Row security limits each of them to the threads the reading person can see and
 *  to that person's own stars and read positions, so a count or an export of them is never the organisation's total:
 *  other members' private threads are invisible. Organisation lifecycle names them through this list, so the private
 *  message, participant and chat-audit tables are referenced only from this module (threads contract §9). */
export const threadTables: readonly string[] = ['threads', 'thread_participants', 'thread_tags', 'thread_messages', 'thread_pins',
 'thread_stars', 'thread_reads', 'chat_audit_events'];

export const threadExportNote = 'Thread tables hold every record and topic thread, only the private threads the exporting person participates in, '
 + 'and only that person’s stars and read positions; other members’ private threads are not exported, so this is not a complete thread backup.';

/** The change journal (migration 0047). Its rows follow their record's visibility: a private thread's tag history is its
 *  participants', and a change set is visible only where one of its changes or versions is. Counts and exports of it
 *  are therefore the reader's view, not the organisation's total, like the thread tables. */
export const journalTables: readonly string[] = ['change_sets', 'record_changes', 'record_versions'];
export const journalExportNote = 'Change history (change_sets, record_changes, record_versions) holds what the exporting person can see: '
 + 'the history of private threads they do not participate in is not exported.';
