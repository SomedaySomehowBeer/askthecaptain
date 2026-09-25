# Stocktake

Counted stock and reorder tasks, D15. Current definition: **Stocktake v3**.
See the [retirement cutover](../plans/assistant-runtime-retirement-2026-09.md) before upgrading old runs.

## Turn it on

In Settings → Workflows, turn on **Stocktake** with a counted-stock **location** and the name of the
**purchasing project** (default Purchasing). The enabling person needs a subscribed push device;
Google and inference are not required. Shopify is optional. Runs are weekly on Monday at
08:00 in the organisation's timezone, or on demand. Migration 0037 turns old versions off and cancels unfinished old runs. Review and enable v3 afresh. The operator must already have installed and started the runner
as described in [workflow-runner.md](workflow-runner.md); the version-3 retirement uses migration 0037 and adds no background process.

Owners/admins can choose **Start a stocktake** in Resources → Inventory and enter a location. That
location is pinned to this run; it does not change the weekly settings or who enabled the workflow.
The button opens the run in Activity. Members cannot start it but can enter counts.

## Count, record, reorder

The enabling person's subscribed devices receive one notification per item, tagged by item id,
linking to Resources → Inventory. Enter a count in its existing count form. A count newer than the run's start wakes
the waiting step in the same transaction as the saved observation. Counts entered early are found
when that item's turn arrives; old counts do not satisfy a new stocktake. The run's recorded
observation is fixed when the wait succeeds. Later corrections remain separate counts.

The wait allows three days per item. If no count arrives, Activity says that wait timed out.
The workflow journals the observation; it does not insert another `stock_counts` row. A count below
the snapshotted reorder point creates **Reorder <item> (<count> <unit> left, reorder at <point>)**,
due seven days later in the organisation's timezone. The named project is created and audited once
if absent. Multiple active projects with that name pause the run until their names are distinct.
Task and observation receipts are idempotent by run, step and loop item.

Supplier details do not trigger email drafting. Reorder tasks require a person to choose any purchase.

## Shop stock and recovery

After counted stock, the workflow reads Shopify's cached tracked variants with reorder points,
by location, and creates the same kind of task for low quantities. Nobody is asked to count them,
and there is no supplier email for Shopify variants. Disconnected or incomplete Shopify data is
journaled as skipped, with no claim that shop stock is sufficient. Sync Shopify in Settings first.
The run reads at most 100 counted items at its location and 100 shop rows with reorder points;
exceeding that bound pauses explicitly instead of silently dropping items.

Count wake-ups remain durable while workers are stopped and continue after restart. A queue-write
failure rolls the count back too, so the form reports failure rather than losing its wake-up.
Disabling the workflow or removing its enabling person pauses further writes. Fix the stated permission or device problem before Resume.
Already completed tasks and observations are retained across retries or cancellation.
