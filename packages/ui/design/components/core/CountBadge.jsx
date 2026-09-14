import React from 'react';

export function CountBadge({ count, style }) {
  return (
    <span style={{
      minWidth: 44, height: 44, borderRadius: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      padding: '0 var(--space-sm)', background: 'var(--accent)', color: 'var(--accent-ink)',
      fontFamily: 'var(--font-sans)', fontWeight: 'var(--weight-heavy)', fontSize: 'var(--text-body)',
      fontVariantNumeric: 'tabular-nums', ...style
    }}>{count}</span>
  );
}
