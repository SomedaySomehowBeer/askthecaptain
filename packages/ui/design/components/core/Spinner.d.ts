/** Indeterminate activity ring — the web stand-in for React Native's ActivityIndicator. */
export interface SpinnerProps {
  size?: number;
  /** Any CSS colour; defaults to the section accent's text colour. */
  color?: string;
  label?: string;
}
export declare function Spinner(props: SpinnerProps): JSX.Element;
