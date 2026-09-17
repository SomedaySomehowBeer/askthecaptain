/** Names why a provider sync stopped without carrying any provider content, mail, or credentials.
 * The reference is shown in the Inbox and Calendar cards and kept in the `*.sync_failed` audit
 * detail, so a failure on the live app can be read from the page instead of from logs that never
 * contain it (docs/runbooks/mail-sync.md, "Diagnosing a failed sync"). */
export type SyncFailure = { stage: string; kind: 'google' | 'database' | 'other'; status?: number; reason?: string; code?: string; name?: string };
type ProviderLike = { status: number; reason: string };
const isProvider = (error: unknown): error is ProviderLike => error instanceof Error && typeof (error as Partial<ProviderLike>).status === 'number' && typeof (error as Partial<ProviderLike>).reason === 'string';
const isPostgres = (error: unknown): error is Error & { code: string } => error instanceof Error && error.name === 'PostgresError' && typeof (error as { code?: unknown }).code === 'string';
export function describeFailure(error: unknown, stage: string): SyncFailure {
	if (isProvider(error)) return { stage, kind: 'google', status: error.status, ...(error.reason ? { reason: error.reason } : {}) };
	if (isPostgres(error)) return { stage, kind: 'database', code: error.code }; // SQLSTATE only; the message can quote data.
	return { stage, kind: 'other', name: error instanceof Error ? error.name : typeof error };
}
const rateLimited = new Set(['dailyLimitExceeded', 'userRateLimitExceeded', 'rateLimitExceeded', 'quotaExceeded', 'RESOURCE_EXHAUSTED']);
/** One plain sentence for the person, then the reference support can act on. */
export function explainFailure(provider: 'Gmail' | 'Google Calendar', failure: SyncFailure): string {
	const reference = `Reference: ${[failure.stage, failure.kind, failure.status, failure.reason, failure.code, failure.name].filter((part) => part !== undefined && part !== '').join(' · ')}.`;
	let cause: string;
	if (failure.kind === 'database') cause = 'The synced data could not be saved. Try Sync now again; if it keeps failing, contact support with the reference.';
	else if (failure.kind !== 'google') cause = 'Try Sync now again; if it keeps failing, contact support with the reference.';
	else if (failure.status === 401 || failure.reason === 'authError' || failure.reason === 'UNAUTHENTICATED') cause = `${provider} no longer accepts Captain's access. Reconnect Google in Settings.`;
	else if (failure.reason === 'accessNotConfigured') cause = `The ${provider} API is not enabled in the Google Cloud project that owns Captain's OAuth client. Enable it in the Google Cloud console, then try Sync now.`;
	else if (failure.reason === 'domainPolicy') cause = `Your Google Workspace administrator has blocked Captain from ${provider}. Ask them to allow the app, then reconnect Google in Settings.`;
	else if (failure.status === 429 || (failure.reason && rateLimited.has(failure.reason))) cause = `${provider} is rate limiting Captain. The next automatic check will retry.`;
	else if (failure.status === 403) cause = `${provider} refused access. Reconnect Google in Settings and allow ${provider} access.`;
	else if (failure.reason === 'timeout') cause = `${provider} was slow to answer. Try Sync now again.`;
	else if (failure.reason === 'network') cause = `${provider} could not be reached. Try Sync now again.`;
	else if (failure.reason === 'account_changed') cause = 'The connected Google account changed during the sync. Try Sync now again.';
	else if (failure.reason === 'not_connected') cause = 'Google is not connected. Connect Google in Settings.';
	else if (failure.reason === 'too_many_pages') cause = `${provider} returned more pages than Captain reads in one run. Try Sync now again.`;
	else if ((failure.status ?? 0) >= 500) cause = `${provider} had a problem answering. Try Sync now again shortly.`;
	else cause = `${provider} answered in a way Captain could not read. Try Sync now again; if it keeps failing, contact support with the reference.`;
	return `${cause} ${reference}`;
}
