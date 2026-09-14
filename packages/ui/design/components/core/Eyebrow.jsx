import React from 'react';

export function Eyebrow({ children, style, ...rest }) {
  return (
    <span style={{
      fontFamily: 'var(--font-sans)', fontSize: 'var(--text-label)', lineHeight: 'var(--leading-label)',
      letterSpacing: 'var(--tracking-eyebrow)', textTransform: 'uppercase',
      fontWeight: 'var(--weight-bold)', color: 'var(--accent-text)', ...style
    }} {...rest}>{children}</span>
  );
}
