One-line: wrapper around the real brand mark in `assets/` — never redraw it.

```jsx
<Logo size={64} src="./assets/logo-mark.svg" />
<Logo variant="bare" size={28} style={{ color: 'var(--text-body)' }} />
```

Notes: pass `src` with the path relative to the page you are building. The badge corner radius is 24% of the size, matching the iOS app icon.
