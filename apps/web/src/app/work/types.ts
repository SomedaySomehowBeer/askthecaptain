import type { TaskStatus } from '../../lib/api.ts';

/** The API's work query row (`GET /v1/organisations/:id/tasks`): top-level tasks only, with their tags. */
export type WorkTask = { id: string; projectId: string | null; title: string; ownerId: string | null; status: TaskStatus; due: string | null; tags: { id: string; name: string }[] };
export type WorkPage = { tasks: WorkTask[]; nextOffset: number | null };
export type Tag = { id: string; name: string };
export type TagPage = { tags: Tag[]; nextOffset: number | null };

export const workTaskHref = (task: { id: string; status?: TaskStatus }): string => `/work/tasks/${task.id}`;
