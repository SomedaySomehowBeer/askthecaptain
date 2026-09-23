# How Captain's mobile views fit together

**Proposal, updated 23 September 2026.** Advances **own commitments** and **brief and answer**.
This maps the Captain/Pip discussion and fifteen mobile mockups. It is not an adopted
replacement for D11 or the live application's navigation.

![Three sections, each with a grouped list to the left of its selected view](navigation.png)

[Zoomable SVG](navigation.svg) · [Editable Mermaid](navigation.mmd) · [Screen mockups](README.md)

The bottom bar has exactly **Work · Chat · Resources**. Work initially opens at **My work**,
filtered to **Assigned to you**. Home is removed. Production, Marketing, Sales and Admin are
tags used in saved views, not sections or workspaces.

Each tab owns a grouped list of views one page to the left of its selected view. The list has
no visible page title; its accessible heading identifies it for assistive technology. The
main view's back chevron opens the list, selecting a row moves right into that view, and
record detail returns to its originating context. The intended native client supports back
gestures and preserves each tab's selection and position when switching sections. The HTML
prototype demonstrates explicit links, not native gestures or state restoration.

| Section | Groups in the list | Views and details |
|---|---|---|
| Work | For you; Across the business; Saved views | My work by default; All tasks; Projects; saved tag filters. Task and project detail open from these views. Upcoming, Sales and Admin entries are scope previews. |
| Chat | Inbox; Projects; Team | All conversations by default; Unread and Following are proposed filters. A linked discussion opens the same conversation from Chat, task or project. General has no detail mockup yet. |
| Resources | Libraries; Planning; Business | Files & assets by default in this concept; Inventory; Equipment schedule; People and Reports. Asset detail preserves the selected version. People and Reports remain to design. |

Green nodes in the diagram have full-screen mockups. The neutral node describes the shell.
The table above identifies views still to design. Arrows between a list and a selected view describe left/right navigation;
dotted arrows show contextual shortcuts. The list names explain the map, not visible page titles.

**Filters select records; view modes present them.** Assignee, tags, project, status and date
combine to narrow shared work. Different filter types combine with AND; multiple selected tags
match any selected tag by default. The active selection stays visible. List, Board, Calendar and
Timeline do not create new task lists. Tasks can have multiple tags. Tags never confer access.
Opening a project shows the whole project unless an explicit local filter is applied.

Marketing's related Files link opens the shared DAM under Resources. Production's Equipment
and Inventory links open those shared resources. Availability continues to show other people's
and projects' reservations, cleaning and maintenance; task filters cannot hide a clash.
A conflicting request remains unconfirmed. Inventory stays a counted list; bookings do not
consume stock. Xero remains accounting authority, with links from business records.

Search and account/settings belong in the header, outside the three-tab bar. Their detailed
screens are still to design. The bar uses a floating capsule, rounded icons and a soft selected
pill based on the supplied Taildrop reference, with Captain's colours and visible labels.
The compact bar is about 80% of its initial width and height; the selected pill is darker than
the bar, with green icon and text.

![Tag, person and project filters select the same task and linked records](relationships.png)

[Zoomable SVG](relationships.svg) · [Editable Mermaid](relationships.mmd)

This second panel maps record identity, not database tables or required relationships. A task
need not have a project, file, booking or discussion. Bidirectional links preserve access checks;
a link never grants access to a private conversation or source file.

For example, Confirm packaging slot appears in My work, the saved Production tag view, All
tasks and the Summer lager project. Each opens the same task and linked conversation. Its
conflicting reservation appears in the project and equipment timeline. Resolving it changes
one reservation, irrespective of the route used to reach it.

Both Mermaid sources are rendered in Chromium with Mermaid 11.12.0. SVG/PNG exports are review
artifacts; the `.mmd` files remain editable sources. No repository dependency is added.
