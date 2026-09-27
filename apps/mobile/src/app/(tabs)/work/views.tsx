import { Screen } from '../../../components/Screen.tsx';
import { ViewList } from '../../../components/ViewList.tsx';

export default function WorkViews() {
	return <Screen section="work" onViewList><ViewList section="work" /></Screen>;
}
