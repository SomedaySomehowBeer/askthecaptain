import React from 'react';

export function Input({ label, hint, invalid = false, style, id, ...rest }) {
  const inputId = id || `atc-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)' }}>
      {label ? <label htmlFor={inputId} style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-meta)', fontWeight: 'var(--weight-medium)', color: 'var(--text-body)' }}>{label}</label> : null}
      <input
        id={inputId}
        style={{
          minHeight: 'var(--tap-target)', border: '1px solid ' + (invalid ? 'var(--status-danger)' : 'var(--line-hairline)'),
          borderRadius: 'var(--radius-button)', padding: '0 var(--space-md)',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)', color: 'var(--text-body)',
          background: 'var(--surface-page)', outlineColor: 'var(--accent-text)', width: '100%', boxSizing: 'border-box', ...style
        }}
        {...rest}
      />
      {hint ? <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-meta)', lineHeight: 'var(--leading-meta)', color: invalid ? 'var(--status-danger)' : 'var(--text-muted)' }}>{hint}</span> : null}
    </div>
  );
}
