import { Screen } from '../../../components/Screen.tsx';
import { ViewList } from '../../../components/ViewList.tsx';

export default function ResourcesViews() {
	return <Screen section="resources" onViewList><ViewList section="resources" /></Screen>;
}
