import React from 'react';

const tones = {
  neutral:      { dot: 'var(--text-muted)',        fg: 'var(--text-muted)' },
  live:         { dot: 'var(--status-live)',       fg: 'var(--status-live)' },
  pending:      { dot: 'var(--status-pending)',    fg: 'var(--status-pending)' },
  error:        { dot: 'var(--status-error)',      fg: 'var(--status-error)' },
  disconnected: { dot: 'var(--status-disconnected)', fg: 'var(--status-disconnected)' }
};

export function Chip({ children, tone = 'neutral', dot = true, style }) {
  const t = tones[tone] ?? tones.neutral;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 'var(--space-sm)',
      padding: '5px 10px', borderRadius: 'var(--radius-chip)',
      border: '1px solid var(--line-hairline)', background: 'var(--surface-card)',
      fontFamily: 'var(--font-sans)', fontSize: 'var(--text-label)', lineHeight: 'var(--leading-label)',
      fontWeight: 'var(--weight-bold)', color: t.fg, ...style
    }}>
      {dot ? <span style={{ width: 8, height: 8, borderRadius: 4, background: t.dot }} /> : null}
      {children}
    </span>
  );
}
