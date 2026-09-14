import type { ReactNode, CSSProperties } from 'react';

/**
 * Small status pill. Tones map to the sync states in the work/CRM mirror
 * (`live`, `pending`, `error`, `disconnected`).
 */
export interface ChipProps {
  children?: ReactNode;
  tone?: 'neutral' | 'live' | 'pending' | 'error' | 'disconnected';
  dot?: boolean;
  style?: CSSProperties;
}
export declare function Chip(props: ChipProps): JSX.Element;
