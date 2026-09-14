One-line: status pill for connection and container sync state.

```jsx
<Chip tone="live">Live</Chip>
<Chip tone="pending">Backfilling</Chip>
<Chip tone="error">Sync error</Chip>
```

Notes: an intentional addition (see readme) — the repo defines the state vocabulary but no chip. Keep the wording to the state names the API returns.
