import { SectionStack, sectionStackSettings } from '../../../components/SectionStack.tsx';

/** Native stacks built from links use the Work view list as their anchor; an empty stack starts at My work.
 * Device navigation proof remains a separate gate (see sectionStackSettings). */
export const unstable_settings = sectionStackSettings;
export default SectionStack;
