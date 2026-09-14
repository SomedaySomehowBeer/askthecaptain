One-line: the app's only button — solid accent (primary), hairline outline (secondary) or danger outline, full-width by default.

```jsx
<Button label="Continue with Google" />
<Button label="Sync now" variant="secondary" loading={syncing} />
<Button label="Disconnect Shopify" variant="danger" block={false} />
```

Notes: min height 52px, radius 16px, weight 700. Pressed = 72% opacity (never a colour shift); disabled = 45%. `primary` picks up whichever section accent is in scope, so a Button inside `.accent-amber` is amber with dark-amber text.
