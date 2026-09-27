import { SectionStack, sectionStackSettings } from '../../../components/SectionStack.tsx';

/** On iOS and Android, opening a Chat view places the Chat view list beneath it (see sectionStackSettings). */
export const unstable_settings = sectionStackSettings;
export default SectionStack;
