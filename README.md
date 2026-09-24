# Ask The Captain

The shared project and work system for a small business: projects, tasks, recurring duties and
their owners, tags, equipment reservations, and the conversations and evidence around that work,
organised into **Work, Chat and Resources**.
A separate personal assistant, Pip, will handle each person's own mail, calendar and reminders.

The web app now has the Work/Chat/Resources shell. Work lists real tasks, defaults to your open
tasks, and supports owner, status, project and tag filters plus task creation. Shared tags can be
created and renamed, and added to or removed from individual tasks. Existing pages and
data remain reachable through the grouped view lists; the former landing page is at `/today`.
Chat, equipment scheduling, saved views and the mobile app remain to be built. Hosted services
remain recorded as stopped; staging-only resumption is authorised when needed, with at most one
machine per app ([operational status](docs/runbooks/paused.md)).

- [The plan](docs/plan.md) is the source of truth: what Captain is and its decisions.
- [The delivery plan](docs/plans/captain-workspace-delivery-2026-09.md) sequences the workspace.
- [Pip's implementation plan](https://github.com/SomedaySomehowBeer/askthecaptain/issues/119) tracks the separate personal assistant.
- [Documentation audit](docs/plans/documentation-audit-2026-09.md) records coverage, corrections and remaining decisions.
- [AGENTS.md](AGENTS.md) holds the rules for anyone writing code here.
- `docs/proposals/` keeps the discussions that led to the plan, as history; the plan wins where they differ.
- `docs/runbooks/` explains how the running (legacy) features are set up and operated.
