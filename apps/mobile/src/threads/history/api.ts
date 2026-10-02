/** History, a version, the preview and the apply (versions contract §5), through the thread calls' one request path:
 *  the scope is checked before and after every request, so an answer for another person, organisation or epoch is
 *  dropped ('stale'). Nothing here retries. */
import { organisationPath } from '../../api/paths.ts';
import type { ReadScope } from '../../account/contracts.ts';
import type { Result, ThreadCalls } from '../api.ts';
import { queryPath } from '../api.ts';
import type { JournalRecordKind } from '../contracts.ts';
import type { Applied, Basis, HistoryPage, Preview, Version } from './contracts.ts';
import { parseApplied, parseHistory, parsePreview, parseVersion } from './parse.ts';
import { uuid } from '../parse.ts';

export const historyPageSize = 20;
export type Target = { kind: JournalRecordKind; id: string };
export type ApplyBody = { id: string; changeIds: string[]; basis: Basis[] };

export const historyCalls = {
	page: (calls: ThreadCalls, scope: ReadScope, target: Target, before?: string): Promise<Result<HistoryPage>> =>
		calls.request(scope, 'GET', queryPath(organisationPath(scope.organisationId, 'history', target.kind, uuid(target.id)), { limit: historyPageSize, before }), undefined, (v) => parseHistory(v, target)),
	version: (calls: ThreadCalls, scope: ReadScope, target: Target, revision: number): Promise<Result<Version>> =>
		calls.request(scope, 'GET', organisationPath(scope.organisationId, 'history', target.kind, uuid(target.id), 'versions', String(revision)), undefined, (v) => parseVersion(v, { ...target, revision })),
	preview: (calls: ThreadCalls, scope: ReadScope, changeIds: readonly string[]): Promise<Result<Preview>> =>
		calls.request(scope, 'POST', organisationPath(scope.organisationId, 'reversals', 'preview'), { changeIds: [...changeIds] }, (v) => parsePreview(v, changeIds)),
	apply: (calls: ThreadCalls, scope: ReadScope, body: ApplyBody): Promise<Result<Applied>> =>
		calls.request(scope, 'POST', organisationPath(scope.organisationId, 'reversals'), body, (v) => parseApplied(v, body))
};
