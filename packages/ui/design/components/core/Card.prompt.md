One-line: the standard content surface — white, 22px radius, 24px padding, 16px internal gap, hairline border, never a drop shadow.

```jsx
<Card>
  <CardTitle>3 captures on this phone</CardTitle>
  <CardCopy>1 needs another try.</CardCopy>
  <Button label="Retry failed captures" variant="secondary" />
</Card>
```

Notes: cards stack in a 24px gap column. Use `tone="inverse"` only for the capture tiles' family of dark surfaces; `tone="accent"` for a single highlighted card per screen at most.
