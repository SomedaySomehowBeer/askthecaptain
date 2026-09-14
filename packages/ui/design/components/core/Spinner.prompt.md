One-line: compass for loading buttons and full-screen waits — a static rose, a needle that turns until Captain has found its bearing.

```jsx
<Spinner size={32} />
```

Notes: the needle sweeps unevenly (fast then settling) so it reads as seeking, not as a generic ring. Full-screen waits centre a 36px compass on the paper page; inside a primary Button it inherits `--accent-ink`. Minimum useful size is 16px.
