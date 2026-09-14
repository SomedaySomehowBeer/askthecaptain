import type { InputHTMLAttributes, CSSProperties } from 'react';

/**
 * Single-line text field. Same 52px height and 16px radius as Button so they stack cleanly.
 */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Helper line under the field; turns danger-red when `invalid`. */
  hint?: string;
  invalid?: boolean;
  style?: CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;
