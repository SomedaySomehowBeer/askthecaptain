import React from 'react';

export function Logo({ size = 48, variant = 'mint', src, style }) {
  const badge = variant === 'mint';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: Math.round(size * 0.24),
      background: badge ? 'var(--atc-mint)' : 'transparent',
      color: badge ? 'var(--atc-mint-ink)' : 'currentColor',
      overflow: 'hidden', ...style
    }}>
      <img src={src || (badge ? '../../assets/logo-mark-ink.svg' : '../../assets/logo-mark-ink.svg')} alt="Ask The Captain" width={Math.round(size * (badge ? 0.82 : 1))} height={Math.round(size * (badge ? 0.82 : 1))} style={{ display: 'block' }} />
    </span>
  );
}
