import type { CSSProperties } from 'react';

/**
 * The octopus-captain mark. `mint` renders it as the app-icon badge; `bare` renders
 * the silhouette alone in `currentColor`.
 */
export interface LogoProps {
  size?: number;
  variant?: 'mint' | 'bare';
  /** Override the asset path — set this to the correct relative path to `assets/logo-mark.svg`. */
  src?: string;
  style?: CSSProperties;
}
export declare function Logo(props: LogoProps): JSX.Element;
