import React from 'react';
import { Spinner } from './Spinner.jsx';

const base = {
  minHeight: 'var(--tap-target)', padding: '0 var(--space-lg)', display: 'inline-flex',
  alignItems: 'center', justifyContent: 'center', gap: 'var(--space-sm)',
  borderRadius: 'var(--radius-button)', borderWidth: 1, borderStyle: 'solid',
  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-body)', fontWeight: 'var(--weight-bold)',
  lineHeight: 'var(--leading-body)', cursor: 'pointer', width: '100%',
  transition: 'opacity var(--duration-fast) var(--ease-standard)'
};

const variants = {
  primary:   { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-ink)' },
  secondary: { background: 'transparent', borderColor: 'var(--line-hairline-color, var(--line-hairline))', color: 'var(--text-body)' },
  danger:    { background: 'transparent', borderColor: 'var(--status-danger)', color: 'var(--status-danger)' }
};

export function Button({ label, children, variant = 'primary', loading = false, disabled = false, icon = null, block = true, style, ...rest }) {
  const blocked = disabled || loading;
  return (
    <button
      type="button"
      disabled={blocked}
      style={{
        ...base,
        ...variants[variant],
        borderColor: variant === 'secondary' ? 'var(--line-hairline)' : variants[variant].borderColor,
        width: block ? '100%' : 'auto',
        opacity: blocked ? 'var(--disabled-opacity)' : 1,
        cursor: blocked ? 'not-allowed' : 'pointer',
        ...style
      }}
      {...rest}
    >
      {loading
        ? <Spinner color={variant === 'primary' ? 'var(--accent-ink)' : 'var(--text-body)'} size={20} />
        : <>{icon}{label ?? children}</>}
    </button>
  );
}
