# Stocktake

**Job 4 — Own commitments (D15).** A stocktake asks for counts, keeps the person's observations,
and creates reorder tasks and drafts. It never computes stock from movements or sends an order.

## Turn it on

In Settings → Workflows, turn on **Stocktake** with a counted-stock **location** and the name of the
**purchasing project** (default Purchasing). The enabling person needs a subscribed push device;
Google must be connected and inference ready. Shopify is optional. Runs are weekly on Monday at
08:00 in the organisation's timezone, or on demand. Version 2 needs its parameters saved again if
an older definition was enabled. The operator must already have installed and started the runner
as described in [workflow-runner.md](workflow-runner.md); this feature adds no process or migration.

Owners/admins can choose **Start a stocktake** in Commitments → Stock and enter a location. That
location is pinned to this run; it does not change the weekly settings or who enabled the workflow.
The button opens the run in Activity. Members cannot start it but can enter counts.

## Count, record, reorder

The enabling person's subscribed devices receive one notification per item, tagged by item id,
linking to Stock. Enter a count in its existing count form. A count newer than the run's start wakes
the waiting step in the same transaction as the saved observation. Counts entered early are found
when that item's turn arrives; old counts do not satisfy a new stocktake. The run's recorded
observation is fixed when the wait succeeds. Later corrections remain separate counts.

The wait allows three days per item. If no count arrives, Activity says that wait timed out.
The workflow journals the observation; it does not insert another `stock_counts` row. A count below
the snapshotted reorder point creates **Reorder <item> (<count> <unit> left, reorder at <point>)**,
due seven days later in the organisation's timezone. The named project is created and audited once
if absent. Multiple active projects with that name pause the run until their names are distinct.
Task and observation receipts are idempotent by run, step and loop item.

A preferred supplier is a company. Companies have no direct email field: Captain uses the email
only when exactly one active contact is linked to that company. No supplier, no active contact,
an invalid email or multiple contacts means the email step is skipped with a note in Activity;
the reorder task still exists. Edit the linked contacts in People and companies for future runs.
The infer step receives labelled untrusted item/unit/count/reorder/supplier-name data, with a fixed
instruction and validated output. No usual order quantity is stored today, so it is passed as
unknown; the draft asks about availability/quantity instead of inventing an order amount.

The short email waits in Inbox's Outbox as a standalone draft addressed to that supplier.
A person reviews and sends it. The draft pins the Google account; reconnecting another account
cannot send it. Missing Google access pauses draft creation until reconnection and Resume.

## Shop stock and recovery

After counted stock, the workflow reads Shopify's cached tracked variants with reorder points,
by location, and creates the same kind of task for low quantities. Nobody is asked to count them,
and there is no supplier email for Shopify variants. Disconnected or incomplete Shopify data is
journaled as skipped, with no claim that shop stock is sufficient. Sync Shopify in Settings first.
The run reads at most 100 counted items at its location and 100 shop rows with reorder points;
exceeding that bound pauses explicitly instead of silently dropping items.

Count wake-ups remain durable while workers are stopped and continue after restart. A queue-write
failure rolls the count back too, so the form reports failure rather than losing its wake-up.
Disabling the workflow or removing its enabling person pauses further writes. Inference sign-in
and budget failures show the normal actionable runner pauses; fix the cause, then Resume.
Already completed tasks, drafts and observations are retained across retries or cancellation.
