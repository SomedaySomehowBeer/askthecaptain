# Discover projects (D22)

Captain proposes projects from evidence and a person makes them real. The workflow **Discover projects** runs at
06:00, when a person asks from a thread or note, and on demand from Settings → Workflows. Nothing it writes is
active until a person accepts it on Commitments.

## What a run does

1. **Seeds** (`discovery.seeds`). Deterministic thresholds, constants in `apps/api/src/discovery/thresholds.ts`,
   decide what is worth a model call: a candidate name the triage model proposed for at least three threads or
   notes across at least fourteen days (underway), or for two sources, or one thread in which both parties wrote
   (idea), or two of the person's own items; two or more suggested duties in Obligations that share a counterparty
   and a reference; a thread or note a person chose; and on the very first run, clusters of the synced backlog by
   thread vector. At most ten seeds run per invocation, a person's request first. A candidate is seeded again only
   when it has gathered sources since it was last seeded; one a person discarded is closed for good.
2. **Evidence** (`discovery.evidence`). The seed's own threads and notes, the nearest threads and notes from the
   index (when the embedding service is reachable), then deterministic widening from the seed's sources: the same
   counterparty company, shared references, the reply chain, the normalised subject, and a note's shared event,
   company, project or task, all within sixty days either side of the seed. At most fifty candidates, each with an
   opaque id valid for that call only. Every read runs under the tenant's row security.
3. **One large-tier call** (`discoverProject`) judges the evidence: a project (with a brief, stage and tasks each
   with steps and an evidence id), one task, a relationship, or nothing. The definitions are in the instruction.
4. **Record** (`discovery.record`). Ids outside the candidate set are dropped, never guessed. A project is written
   as **proposed** with its brief (each line citing the thread or note it rests on), its thread and note links, its
   suggested tasks with steps, and evidence rows; a task becomes one suggested task in the seed's linked project or
   Obligations; a relationship journals the counterparty's company; nothing is journaled as nothing.
5. **Notify** (`discovery.notify`) pushes "Captain proposes …" to the enabling person when a device is subscribed.

## The person's part

- `POST /v1/organisations/:id/discovery/requests` `{ kind: 'mail_thread' | 'note', id }` queues a seed for the
  thread or note and starts a run (Make this a project on the thread and note pages).
- `POST /v1/organisations/:id/projects/:projectId/accept` sets a proposal active and its suggested tasks and steps
  open; `…/discard` archives it, cancels its suggested tasks and closes its candidate. Both are audited.
- Proposed projects never count as active: triage does not offer them, tasks cannot be added to them by hand, and
  Commitments shows them as proposals.

## Owner steps

Enable **Discover projects** in Settings → Workflows once inference is ready. The index (`docs/runbooks/embedding.md`)
improves the evidence but is not required; without it, only widening by counterparty, references, reply chain,
subject and links applies.
