import type { ReactNode, CSSProperties } from 'react';

/**
 * The surface everything sits on: 22px radius, hairline border, no shadow.
 */
export interface CardProps {
  children?: ReactNode;
  /** default = white on cream; sunken = tinted well; inverse = ink; accent = soft accent wash. */
  tone?: 'default' | 'sunken' | 'inverse' | 'accent';
  padding?: string;
  style?: CSSProperties;
}
export declare function Card(props: CardProps): JSX.Element;
