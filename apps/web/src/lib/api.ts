import { apiUrl } from './env.ts';

export class ApiError extends Error {
	readonly status: number; readonly code: string; readonly requestId: string | null;
	constructor(status: number, code: string, message: string, requestId: string | null) { super(message); this.status = status; this.code = code; this.requestId = requestId; this.name = 'ApiError'; }
	get offline() { return this.status === 0; }
	get unauthorised() { return this.status === 401; }
}

export type Me = { user: { id: string; email: string; name: string }; memberships: Membership[]; passkeyVerified?: boolean };
export type Membership = { organisationId: string; organisationName: string; role: Role; status: string };
export type Role = 'owner' | 'admin' | 'member';
export type Organisation = { id: string; name: string; timezone: string; locale: string; createdAt: string; role: Role };
export type Member = { userId: string; name: string; email: string; role: Role; status: string; since: string };
export type Invitation = { id: string; email: string; role: Exclude<Role, 'owner'>; invitedBy: string; expiresAt: string; createdAt: string };

/** One call to the API. Throws `ApiError` with the API's own code and message, or status 0 when the
 *  API could not be reached at all. */
export async function api<T>(path: string, options: { token?: string; method?: string; body?: unknown } = {}): Promise<T> {
	let response: Response;
	try {
		response = await fetch(new URL(path, apiUrl), { method: options.method ?? 'GET', cache: 'no-store',
			headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
			body: options.body === undefined ? undefined : JSON.stringify(options.body) });
	} catch { throw new ApiError(0, 'offline', 'Captain could not reach its API just now.', null); }
	if (!response.ok) {
		const detail = (await response.json().catch(() => ({}))) as { code?: string; error?: string };
		throw new ApiError(response.status, detail.code ?? 'error', detail.error ?? 'That did not work.', response.headers.get('x-request-id'));
	}
	return (await response.json()) as T;
}

export type Loaded<T> = { ok: true; value: T } | { ok: false; error: ApiError };
/** A read either answered or it did not; pages render the refusal as a designed state, not a throw. */
export async function load<T>(work: () => Promise<T>): Promise<Loaded<T>> {
	try { return { ok: true, value: await work() }; }
	catch (error) { return { ok: false, error: error instanceof ApiError ? error : new ApiError(0, 'unknown', 'That could not be read.', null) }; }
}

// Commitments (D7)
export type TaskStatus = 'suggested' | 'open' | 'in_progress' | 'done' | 'cancelled';
export type Project = { id: string; name: string; description: string; stages: string[]; ownerId: string | null; systemKind: 'obligations' | null; archivedAt: string | null; createdAt: string; updatedAt: string };
export type Evidence = { id: string; taskId: string; kind: 'mail' | 'file' | 'url'; reference: string; label: string; attachedBy: string | null; attachedAt: string };
export type Task = { id: string; projectId: string; title: string; body: string; status: TaskStatus; ownerId: string | null; ownerName: string | null; due: string | null;
	sourceKind: 'person' | 'mail' | 'series' | 'run' | 'note'; sourceId: string | null; seriesId: string | null; periodStart: string | null; periodEnd: string | null; evidenceRequired: boolean;
	completedBy: string | null; completedAt: string | null; createdAt: string; updatedAt: string; evidence: Evidence[] };
export type Recurrence = 'monthly' | 'quarterly' | 'yearly' | 'weekdays' | 'custom';
export type Series = { id: string; projectId: string; title: string; body: string; ownerId: string | null; evidenceRequired: boolean; recurrence: Recurrence; everyMonths: number | null;
	anchor: string; dueOffsetDays: number; pausedAt: string | null; nextDue: string | null; createdAt: string; updatedAt: string };
export type Commitments = { projects: Project[]; tasks: Task[]; series: Series[]; today: string; timezone: string };

// Workflows (D3, D4)
export type WorkflowParameterSpec = { type: 'text'; description: string; default?: string; required?: boolean; maxLength?: number } | { type: 'boolean'; description: string; default: boolean } | { type: 'number'; description: string; default: number; min?: number; max?: number };
export type WorkflowTrigger = { kind: 'event'; event: string } | { kind: 'daily'; at: string } | { kind: 'weekly'; day: string; at: string } | { kind: 'manual' };
/** A definition's steps as the API sends them (packages/steps `definition.ts`, plan §6). */
export type WorkflowPredicate = { truthy: string } | { eq: [string, string | number | boolean | null] } | { gt: [string, number] } | { lt: [string, number] } | { param: string } | { not: WorkflowPredicate } | { and: WorkflowPredicate[] } | { or: WorkflowPredicate[] };
export type WorkflowArg = string | number | boolean | null | { ref: string } | { param: string } | string[];
export type WorkflowActionStep = { kind: 'read' | 'infer' | 'write' | 'await' | 'notify'; key: string; args?: Record<string, WorkflowArg>; as?: string; when?: WorkflowPredicate; schema?: string; tier?: 'small' | 'large'; timeoutDays?: number };
export type WorkflowStep = WorkflowActionStep | { kind: 'each'; list: string; steps: WorkflowStep[]; independent?: boolean } | { kind: 'branch'; when: WorkflowPredicate; then: WorkflowStep[]; else?: WorkflowStep[] };
export type WorkflowDefinition = { key: string; version: number; name: string; description: string; job: number; triggers: WorkflowTrigger[]; parameters: Record<string, WorkflowParameterSpec>; steps: WorkflowStep[] };
/** What each catalogue step does, in the catalogue's words. */
export type WorkflowCatalog = Record<string, { kind: string; does: string; until: string | null }>;
export type WorkflowEnablement = { id: string; enabled: boolean; enabledBy: string | null; enabledByName: string | null; parameters: Record<string, unknown>; updatedAt: string; definitionVersion: number };
export type OfferedWorkflow = { definition: WorkflowDefinition; requirements: string[]; unmet: { requirement: string; words: string }[]; enablement: WorkflowEnablement | null; runnerProblem?: string | null };
export type WorkflowRun = { id: string; definitionKey: string; definitionVersion: number; trigger: unknown; state: string; reason: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string };

export type WorkflowRunDetail = WorkflowRun & { steps: { path: string; itemIndex: number | null; key: string; state: string; error: string | null; output?: unknown }[] };
