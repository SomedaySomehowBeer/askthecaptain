import React from 'react';

/** Compass spinner — a static rose with a needle that keeps turning until the wait is over. */
export function Spinner({ size = 24, color = 'var(--accent-text)', label = 'Loading' }) {
  const sw = Math.max(1.5, size / 16);
  return (
    <span role="status" aria-label={label} style={{ display: 'inline-flex', width: size, height: size, flex: `0 0 ${size}px`, lineHeight: 0, color }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round">
        <circle cx="12" cy="12" r="10.5" />
        <path d="M12 1.5v2M12 20.5v2M1.5 12h2M20.5 12h2" opacity=".55" />
        <g style={{ transformOrigin: '12px 12px', animation: 'atc-compass 1.4s cubic-bezier(.4,0,.2,1) infinite' }}>
          <path d="M12 4.5l2.4 7.5H9.6z" fill="currentColor" stroke="none" />
          <path d="M12 19.5l2.4-7.5H9.6z" fill="currentColor" opacity=".3" stroke="none" />
          <circle cx="12" cy="12" r="1.2" fill="var(--surface-page,#f3ecdf)" stroke="none" />
        </g>
      </svg>
      <style>{'@keyframes atc-compass{0%{transform:rotate(0)}50%{transform:rotate(200deg)}100%{transform:rotate(360deg)}}'}</style>
    </span>
  );
}
