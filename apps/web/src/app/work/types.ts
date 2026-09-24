import type { TaskStatus } from '../../lib/api.ts';

/** The API's work query row (`GET /v1/organisations/:id/tasks`): top-level tasks only, with their tags. */
export type WorkTask = { id: string; projectId: string; title: string; ownerId: string | null; status: TaskStatus; due: string | null; tags: { id: string; name: string }[] };
export type WorkPage = { tasks: WorkTask[]; nextOffset: number | null };
export type Tag = { id: string; name: string };
export type TagPage = { tags: Tag[]; nextOffset: number | null };

/** There is no task page yet: a task opens where it is edited today, on Commitments, at its own anchor.
 *  Commitments does not list cancelled tasks, so a cancelled task has nowhere to open. */
export const workTaskHref = (task: { id: string; status?: TaskStatus }): string | null =>
	task.status === 'cancelled' ? null : `/commitments#task-${task.id}`;
