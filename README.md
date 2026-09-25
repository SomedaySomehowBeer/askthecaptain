# Ask The Captain

The shared project and work system for a small business: projects, tasks, recurring duties and
their owners, tags, equipment reservations, and the conversations and evidence around that work,
organised into **Work, Chat and Resources**.
A separate personal assistant, Pip, will handle each person's own mail, calendar and reminders.

The web app has the three-tab shell, filtered Work and task creation, shared tags, counted
inventory and an equipment timeline with booking controls. Task/project detail still uses legacy
paths; removing those and the old assistant runtime is the next scope-cleanup work. Chat, saved
views, files/DAM and the native app remain planned. The current plan does not retain Commitments,
Obligations or Inbox as product requirements, or make their retirement depend on Pip.

Staging resumed with one machine per app; production remains paused. See the dated
[operational status](docs/runbooks/paused.md) for actual release evidence.

- [The plan](docs/plan.md) is the source of truth: what Captain is and its decisions.
- [The delivery plan](docs/plans/captain-workspace-delivery-2026-09.md) sequences the workspace.
- [Pip's implementation plan](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119) tracks the separate personal assistant.
- [Scope audit](docs/plans/captain-scope-audit-2026-09-25.md) records plan/issue coverage, corrections and review.
- [AGENTS.md](AGENTS.md) holds the rules for anyone writing code here.
- `docs/proposals/` keeps the discussions that led to the plan, as history; the plan wins where they differ.
- `docs/runbooks/` distinguishes current infrastructure from legacy-feature maintenance; it does not set product scope.
