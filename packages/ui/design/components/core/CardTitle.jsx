import React from 'react';

export function CardTitle({ children, style, ...rest }) {
  return <h3 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-card-title)', lineHeight: 'var(--leading-card-title)', fontWeight: 'var(--weight-bold)', color: 'inherit', ...style }} {...rest}>{children}</h3>;
}

export function CardCopy({ children, style, ...rest }) {
  return <p style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-meta)', lineHeight: 'var(--leading-meta)', color: 'var(--text-muted)', textWrap: 'pretty', ...style }} {...rest}>{children}</p>;
}
