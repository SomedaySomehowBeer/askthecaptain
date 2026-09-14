# Design system mirror

This directory mirrors the **Ask The Captain Design System** project in Claude Design, which is the
design authority (plan §10, D14). Edit there; re-import here; never hand-edit these files.

Imported: `tokens/` (colour, typography, spacing, shape, motion, fonts), `assets/` (the octopus
mark, lockups, app icons, marketing posters), `styles.css` (the system's base classes) and
`components/core/` (reference implementations from the design tool, plain JSX with inline styles;
the web adapts them rather than importing them).

`apps/web` imports the token files directly from `@captain/ui/design/tokens/*.css`.
