import React from 'react';

export function Card({ children, tone = 'default', padding, style, ...rest }) {
  const tones = {
    default: { background: 'var(--surface-card)', borderColor: 'var(--line-hairline)', color: 'var(--text-body)' },
    sunken:  { background: 'var(--surface-sunken)', borderColor: 'transparent', color: 'var(--text-body)' },
    inverse: { background: 'var(--surface-inverse)', borderColor: 'transparent', color: 'var(--text-on-inverse)' },
    accent:  { background: 'var(--accent-soft)', borderColor: 'transparent', color: 'var(--text-body)' }
  };
  return (
    <div style={{
      borderRadius: 'var(--radius-card)', padding: padding ?? 'var(--space-lg)',
      display: 'flex', flexDirection: 'column', gap: 'var(--card-gap)',
      borderWidth: 1, borderStyle: 'solid', ...tones[tone], ...style
    }} {...rest}>{children}</div>
  );
}
