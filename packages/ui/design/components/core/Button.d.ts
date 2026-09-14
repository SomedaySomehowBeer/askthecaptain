import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The one button. Primary is a solid accent slab; secondary is a hairline outline;
 * danger is an outline in the danger red. Full-width by default — the app is phone-first.
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Button text. `children` works too. */
  label?: string;
  children?: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  /** Swaps the label for a spinner and blocks presses. */
  loading?: boolean;
  disabled?: boolean;
  /** Optional leading glyph or icon element. */
  icon?: ReactNode;
  /** Full-width (default) vs shrink-to-content. */
  block?: boolean;
}
export declare function Button(props: ButtonProps): JSX.Element;
