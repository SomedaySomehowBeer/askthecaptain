import type { ReactNode, CSSProperties } from 'react';
/** 18/24 bold card heading. */
export interface CardTitleProps { children?: ReactNode; style?: CSSProperties }
/** 14/21 muted supporting line under a CardTitle. */
export interface CardCopyProps { children?: ReactNode; style?: CSSProperties }
export declare function CardTitle(props: CardTitleProps): JSX.Element;
export declare function CardCopy(props: CardCopyProps): JSX.Element;
