# Captain mobile workspace mockups

**Review concept, 22 September 2026.** Three proposed screens for the Captain/Pip split.
All names, assignments, dates, quantities and conversations shown here are illustrative.
These are documentation artifacts, not implemented application routes or adopted navigation.

![Three mobile screens: My work, Marketing and Summer lager launch](overview.png)

| Screen | Preview | What to review |
|---|---|---|
| A person's working day | [My work](day.png) | Assignments across all four areas, the next equipment booking and a message linked to a task. |
| A business area | [Marketing](marketing.png) | Campaign work across projects, and access to a shared asset library with explicit versions and review states. |
| A project spanning the business | [Summer lager launch](project.png) | Production, Marketing, Sales and Admin together; a confirmed equipment booking, an unconfirmed conflicting request, and a linked discussion. |

The same screens after scrolling show the linked conversations and complete asset details:

![Scroll continuation of the same three mobile screens](overview-scrolled.png)

## Navigation being proposed

The same four mobile destinations stay in place: **Home, Work, Chat, Browse**.
Home shows the person's working day; Work contains tasks and projects with list, board,
calendar and timeline views; Chat gathers conversations; Browse exposes the business areas
and shared resources. Marketing is reached through Browse; a launch belongs under Work.
Settings is reached from the account surface in the eventual design.

Area, project and person are different ways to select shared records. Projects span areas;
people work across areas. Opening a project shows the whole project, with area filtering an
explicit choice. Equipment scheduling is a required shared capability, available through
Production, a project's schedule and the person's relevant bookings.

The three layouts use Captain's existing forest/paper/mint palette, Fraunces/Inter type and
logo from `packages/ui/design`. Small navigation icons and illustrative asset thumbnails
are authored in this prototype. No Embrace or BrewPlan code, designs or artwork is imported.
The supplied BrewPlan mockups informed the discussion about project context and equipment
timelines; these screens explore Captain's own navigation and visual system.

## Review the editable source

[index.html](index.html) contains the editable layouts, styles and light navigation.
Serve the repository root, then open:

```text
/docs/proposals/assets/captain-mobile-2026-09-22/index.html
/docs/proposals/assets/captain-mobile-2026-09-22/index.html?screen=day
/docs/proposals/assets/captain-mobile-2026-09-22/index.html?screen=marketing
/docs/proposals/assets/captain-mobile-2026-09-22/index.html?screen=project
```

For example, run `python3 -m http.server 8769 --bind 127.0.0.1` from the repository root.
The PNGs need no server. The HTML uses repository-relative design tokens and the existing
Google Fonts stylesheet; system serif/sans fallbacks apply when fonts cannot be fetched.

Browse → Marketing → Summer lager launch demonstrates movement between views. Home returns
to My work. Project Schedule scrolls to bookings. Chat, asset and scheduling controls open
explanatory preview sheets; they do not create records or demonstrate working integrations.
Launch task rows illustrate navigation to their project rather than a fourth task-detail screen;
other work opens a note explaining its separate context.
The content scrolls independently above the persistent bottom navigation.

The equipment preview distinguishes a confirmed tank reservation from a conflicting packaging
request. “Review available times” explains the conflict; it does not claim a new slot is free
or reserve one. The full equipment timeline is required follow-up design, outside these three
requested screens. Production process tracking, recipe models and stock deductions are not
implied by an equipment reservation.

Asset thumbnails are neutral illustrative artwork. Version review, project/task backlinks and
shared-library access are proposed; provider storage, preview and version preservation still
follow the separate files proposal. Chat links should reference one discussion, with access
checks in both directions, rather than duplicate message contents into each view.

## Validation

- Rendered in the shared Chromium browser using Playwright at 360, 390 and 430 CSS pixels wide.
- Checked all three screens for horizontal overflow, vertical scroll access and persistent navigation.
- Exercised Browse → Marketing → project, equipment conflict details, linked discussion and dismissal.
- Checked JavaScript errors and visually inspected the captured previews.
- PNG screen captures are 390 × 874; the overview shows the three at the same scale.

This is a visual proposal with illustrative populated/conflict states. Complete empty, loading,
failed, disabled and permission states must be designed before application implementation.
No application typecheck, Postgres tests or production-route checks are claimed for these docs.
