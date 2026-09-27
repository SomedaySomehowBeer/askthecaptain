import { WorkListScreen } from '../../../work/WorkListScreen.tsx';

/** Work → My work, the default view: the person's own open tasks in the chosen organisation, read-only
 *  (docs/plans/expo-mobile-my-work-read-2026-09.md §3.5). */
export default function MyWork() {
	return <WorkListScreen view="mine" />;
}
