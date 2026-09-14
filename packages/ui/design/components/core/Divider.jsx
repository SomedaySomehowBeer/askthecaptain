import React from 'react';

export function Divider({ label, style }) {
  const line = { height: 1, flex: 1, background: 'var(--line-hairline)' };
  if (!label) return <div style={{ ...line, flex: 'none', width: '100%', ...style }} />;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', ...style }}>
      <span style={line} />
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)', color: 'var(--text-muted)' }}>{label}</span>
      <span style={line} />
    </div>
  );
}
