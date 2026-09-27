import { SectionStack, sectionStackSettings } from '../../../components/SectionStack.tsx';

/** On iOS and Android the Resources view list is this stack's initial route and linking anchor, beneath the open view
 *  for every entry in docs/plans/expo-mobile-native-navigation-2026-09.md (see sectionStackSettings). Device proof
 *  remains a separate gate. */
export const unstable_settings = sectionStackSettings;
export default SectionStack;
