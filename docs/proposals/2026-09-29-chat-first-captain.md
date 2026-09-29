# Chat-first Captain: records as conversations, agents as members

Status: **proposal, 29 September 2026.** Not adopted. Nothing here changes `docs/plan.md` until a
reviewed amendment does. Outcomes: **discuss work**, **manage shared work**, **allocate resources**.

Prototype: a fictional, clickable set of screens accompanies this proposal (link in the pull request). All names and
data in it are invented.

## Why

- Captain records that a change happened but has no version history a person can see or undo. Tasks, projects and
  series carry a revision number and an audit entry with the new values; earlier values are not kept, and nothing reads
  the audit log back.
- Reviews of `block/buzz` and `macro-inc/macro` showed the value of conversation built into every record, and the cost
  of delivering it as separate chat, task and file products sharing one login.

## Six rules

1. **Every record is a conversation.** A task, project, booking, stock item, production record, company or file has one
   thread. At the top sits its card: the current state. Everything that happened to it is in the thread.
2. **The app is one list of threads.** There are no tabs. Filters narrow the list; views such as the equipment schedule
   open from pinned rows.
3. **Agents are members who do work.** Each has a plain name, its own key and a fixed list of things it can do. Agents
   talk to each other in the open.
4. **Inside the organisation agents act; what goes outside is approved.** Approval is a privilege. A record's owner
   has it for that record; an admin can grant it to an agent within limits.
5. **Everything can be undone.** Every write makes a version. Undo is what lets agents work unapproved.
6. **The model reads and drafts; code decides and writes.**

## Rules in detail

### Navigation
- The home screen is a single list of threads, newest activity first, with what needs the person marked.
- A row is dense: title, time, the record's key facts, the latest message on one line, and a count of what needs you.
- The list is grouped by project. Threads with no project are grouped by kind (stock and suppliers, equipment
  upkeep, people). A group can be folded, and its heading shows how many threads need the person.
- Filters: All, Needs you, Tasks, Bookings, Stock, Records, Files, People.
- Pinned rows open views that are not lists of threads: the equipment schedule, and the team.
- A conversation with no record is a topic: a record whose only content is its thread.
- Private conversations between people stay participant-only, as now (D25), and appear in the same list.

### Threads
- A record thread is visible to whoever can see the record.
- A thread holds messages, change lines written by code from the version rows, and approval cards.
- **The card is small.** It shows the title, the status and two facts side by side (for a task, owner and due
  date). Everything else opens from a fold-out. The card stays in view while the thread scrolls.
- **Messages run oldest to newest**, as in any messaging app. A thread opens at the first unread message, or at the
  newest if there is none. Earlier messages are folded behind one row. Newest-first was considered and rejected:
  exchanges, and agent hand-offs in particular, read backwards.

### Projects
- A project has its own thread, and a new project starts with a planning task. They do different jobs.
- **The planning task** is where setting up happens: agreeing dates, listing tasks, booking equipment, checking stock.
  It has an owner, a due date and steps, and it finishes. Its steps come from a template in code.
- **The project thread** is the project's record: changes to the project itself, decisions that span tasks, and a
  weekly summary. It is quiet by design.
- A message in the project thread that is about one task can be moved to that task's thread.

### Versions and undo
- Every write to a record stores a full snapshot with who did it (person, agent or system), what caused it (the
  message, workflow run or scan) and when.
- The person who asked is not stored separately. It is read from the thread through the cause.
- Changes made together are one change set and undo together.
- Undo writes a new version that restores an earlier snapshot. History is never rewritten.
- Undo is refused, with the reason, when something has already gone outside the organisation, or when restoring would
  break a rule such as a slot that is now taken.

### Agents
- Owners and admins add agents. An agent can do what a member can do, and never what only an admin can.
- What an agent can do is a fixed list in code.
- **Each agent has its own key.** Every write is made with it and recorded against that agent. A key can be replaced
  or withdrawn without touching any other agent. The audit log gains an `agent` actor kind.
- **Agents can trigger each other.** They do so by mentioning one another in a record's thread, so the exchange is
  visible to everyone who can see the record. There are no private channels between agents.
- Loops are stopped by code noticing that nothing is changing, not by counting hand-offs:
  - every chain starts from a person's message, a schedule or a record event, and carries that origin;
  - each hand-off records which agent was asked, about which record, at which version, for what;
  - **an agent is never asked the same thing about the same version twice in one chain.** When that would happen the
    chain stops, Captain says so in the thread, and a person decides;
  - a chain of any length is fine while records keep changing;
  - as a backstop a chain shares one budget of time and inference, set by an admin. When it is spent the chain stops
    and asks a person.

### Approval
Code decides whether approval is needed, never the model.

| Test | Examples |
|---|---|
| The action type is external | Sending a message outside, raising or approving a Xero invoice or bill, placing an order, sharing a file outside, inviting a guest |
| The record is linked to an outside company or person | A contract brewer's tank booking, a supplier delivery slot |

- The record waits as **pending** with an approval card showing exactly what will be sent or done. The content can be
  edited on the card; what is approved is what is sent.
- **Acting as someone else always needs that person.** If an agent would do anything under a person's name, address
  or signature, that person approves it. This holds inside the organisation as well as outside.
- **Taking ownership is a privilege.** Admins and the organisation owner have it, and it can be granted to others.
  Someone with it may take ownership of the record, which is an ordinary, visible, versioned change, and then approve.
  The action then goes out under their name, not the previous owner's.
- **An agent acting as itself approves within limits an admin sets**: what kind of action, which outside companies,
  how much each time and how much each week.
  - It sends under its own name from a shared address.
  - It cannot approve what it drafted itself.
  - Anything outside its limits goes to the record's owner, and is then sent as that person once they approve.
- A record owned by an agent cannot carry an outside action that needs a person. The agent hands it to a person first.

### Pending
- Bookings gain a `pending` status beside `confirmed` and `cancelled`.
- **Pending holds the slot.** The no-overlap rule covers pending and confirmed bookings. There is no expiry.
- The booking's owner, an admin or the organisation owner can cancel a pending booking.
- An agent's booking for internal use is confirmed at once.
- The schedule shows three states: confirmed, pending and cleaning. Pending is never shown as free.

### Files
Files stay in Google Drive and are edited in their own applications. Captain adds no desktop client.

- **Working on.** From a file's thread a person marks that they are working on it. Captain adds a small marker file
  beside the original in Drive, named after the original and the person, and removes it when they finish.
  - The marker shows in Finder and in open dialogs. The original is untouched, so nothing that links to it breaks.
  - It is a signal, not a lock. Captain watches Drive and posts in the thread when someone else saves a change.
- Drive cannot do more than this. Its own lock applies to everyone including the person working; a single file cannot
  have narrower access than its folder; and showing who is editing works only for Microsoft Office files.
- When the person finishes, what is in Drive becomes the next version.
- Version-scoped chat, observed revisions and preserved versions are unchanged from the adopted file direction.

### Worksheets from a photo
Captain prints the worksheet, so code knows the layout and the model only reads handwriting.

| Step | Done by |
|---|---|
| Print a versioned template with a code identifying template, version and record | Code |
| Find the code, straighten the photo, crop each box | Code |
| Read each box into a typed value with a confidence | Model |
| Check units, ranges, totals and known items | Code |
| Save the values as one change set; leave unreadable boxes blank and say so | Code |

- No approval is needed. The scan can be undone as a whole.
- Writing in the notes box is a note. Writing in a margin is a note attached to the nearest row and marked as such.
- The photo is kept and linked from the versions it produced.

### Workflows stay code
The model is used for four narrow jobs, each with a schema-checked result: turning a message into a structured request,
reading a handwritten box, drafting text for an outside message, and summarising a thread. Everything else is code.

## Effect on adopted decisions

| Decision | Effect |
|---|---|
| D2 inference is data-only | Unchanged. The model has no tools |
| D3 typed workflow steps | Unchanged |
| D4 workflows act as the person who enabled them | Amended: agents act under their own name and key, with member-level limits |
| D5 no autonomous correspondence | Amended: outside messages need approval of the exact content, by the owner or by an agent within admin-set limits |
| D11 three tabs | Replaced: one list of threads with filters and pinned views |
| D13 attachment bytes never stored | Amended: Captain stores photos of its own worksheets |
| D25 private chat | Extended: record threads follow the record's audience; private conversations are unchanged |
| Non-goal "a conversational model with tools or autonomous writes" | Reworded: autonomous writes are made by code, from schema-checked results |
| New | Versions and undo; agent identities and keys; agent-to-agent hand-offs; approval as a privilege; pending; file markers |

## What this brings back or adds

- **Outgoing mail.** Sending as the owner needs a send-only mail grant, and agents need a shared sending address.
  Mailbox access was retired in #191; this is narrower but is still a new grant to review.
- **Drive write access** to add and remove marker files, and change notifications to detect saves.
- **Object storage** for worksheet photos. Provisioning is the owner's.
- **Image inference** for handwriting, within the existing inference arrangement.
- **Rework of the Expo client's navigation.** The native client was built around three tabs (#188, #205).

## Suggested order

| Slice | Delivers | Needs a model |
|---|---|---|
| 1. Versions and undo | History and undo for tasks, projects, series, bookings and stock; change lines | No |
| 2. Record threads and the thread list | Every record has its thread; one list with filters | No |
| 3. Pending and owner approval | Pending bookings, take ownership, approve | No |
| 4. File markers | Working on, marker file, change notices | No |
| 5. First agents | Agent identities and keys; Scheduler and Stock keeper; hand-offs | Yes, narrow |
| 6. Worksheets | Templates, scan, photo storage | Yes, narrow |
| 7. Outside messages and agent approval | Send as the owner; approval limits for agents | Yes, drafting |

Slices 1 to 4 are useful without any agent.

## To test before relying on it

- What Finder and an application's open dialog show for the marker file, on the machines the business uses.
- How quickly Drive reports a save, and whether it names who saved.

## Assumptions to confirm

- An agent can own a task.
- The first agents are Scheduler, Stock keeper, Records and Bookkeeper.
- A chain of agent hand-offs has a shared budget of time and inference as a backstop.
- A planning task's steps come from a template, and a message can be moved from a project thread to a task's thread.
- An approving agent cannot approve what it drafted itself.

## Prior art reviewed

- `block/buzz`: rejected as a backbone; ideas borrowed (message send states, content-free push, staged deletion).
- `macro-inc/macro`: a design reference only (AGPL). Borrowed: approval of exact, editable content; capability
  annotations that mark what reaches outside; a short undo window after a send. Not adopted: only-human triggers (agents
  here do trigger each other), sharing by mention, agents holding a person's full authority.
