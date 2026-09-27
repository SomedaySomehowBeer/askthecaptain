import { WorkListScreen } from '../../../work/WorkListScreen.tsx';

/** Work → All tasks: the open tasks the Work API lists for the chosen organisation, assigned to anyone, read-only
 *  (docs/plans/expo-mobile-all-tasks-read-2026-09.md). Open only: In progress, Suggested and Done are not included. */
export default function AllTasks() {
	return <WorkListScreen view="all" />;
}
