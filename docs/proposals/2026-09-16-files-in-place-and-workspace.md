# Proposal: files where people work, with Captain providing context and evidence

**Status:** new proposal for review; no implementation, migration, deployment or change to the approved product boundary is implied.

> **Update, 24 September 2026.** Merged for discussion as #64, with §11 rewritten as generic parts
> in #69; not adopted in full (plan §14). Since the Captain/Pip split (#114, adopted in #116):
> file review and discussion use the shared chat model (D25), not the separate notes and
> annotations of §8 and the `file_annotations` table of §13; personal mail belongs to Pip, so the
> Gmail matching and outbox attachment duties of §§6–7 need reconciling before any slice starts. Provider-held originals and version
> links remain the direction (plan §12, delivery plan slice 5). The text below is unchanged.

**Date:** 16 September 2026.

**Recommended direction:** keep working files in Google Drive, bring selected Embrace viewing and review interactions into Captain, and add a Captain sidebar inside Google Docs and Sheets. Keep each business's own operational records (counts, production logs, inspections, job sheets) in business-owned spreadsheets and printable documents assembled from a small set of generic parts. The brewery is the worked example throughout, not the design.

## 1. Recommendation

Captain should know **which file, which version, what it relates to, and what happened to it**, while people continue using Finder, Illustrator, Google Docs, Google Sheets and Gmail.

Google Drive should hold working originals and their provider-managed revisions. Captain should hold references, version metadata, checksums, task relationships, review notes and correspondence evidence. A small set of important versions should be deliberately preserved when someone attaches evidence, marks artwork ready to use, or prepares an email. Captain should never silently replace an unavailable selected version with the latest file.

The Embrace experience should become a file detail and review surface within Captain: previews, a version panel, annotations and links to the work around an asset. Retire the requirement for Lore, an Embrace server and a custom local sync client. This is a proposed replacement for Embrace's earlier role as Captain's file backend, not an instruction to delete existing repositories or historical assets.

For native Google documents, people should continue editing in Google's applications. A **Captain sidebar inside Docs and Sheets** should expose linked tasks, evidence and correspondence actions. Embedding Google's editor inside Captain is not part of this proposal.

For a business's own operational records, start with **Google Sheets + Docs/PDF templates + Drive scans**: a record kit made of generic parts that any business assembles for its own domain (§11). Add a reviewable paper-to-record pipeline only after the file and evidence foundation works. Captain can remind people, link records and surface unfinished review; it should not become a production system, inventory ledger or configurable database builder for any domain. The brewery is the first business to assemble the kit and is used as the worked example.

This direction supports Captain's existing jobs: inbox triage, correspondence, commitments, chasing, and answering with sources. It does not introduce a seventh product job called “run operations.”

## 2. What was checked, and what has changed

### Current Captain, rather than the older local checkout

The review used the live `SomedaySomehowBeer/askthecaptain` repository at **`702ce6fd96e3c7ea8088ede33b47ab3e184057f4`**, including its [product plan][captain-plan], [repository instructions][captain-agents], connector code, outbox, stocktake workflow and inference runbook. That is the current main revision inspected on 16 September. The plan still labels itself “draft for approval”; the implemented code is separately identified below.

Earlier split planning documents from the previous architecture are not the baseline for this proposal. This document is deliberately standalone.

| Area | Current plan / inspected implementation | Consequence for this proposal |
|---|---|---|
| Product | Six administrative jobs; five tabs | File features must serve existing jobs and fit existing navigation. |
| Inference | Schema-constrained, data-only calls; no tools or credentials | Extractors return candidate data. Deterministic services perform reads and writes. |
| Workflow execution | pg-boss and Captain's runner inside the existing API; tenant journals | Reuse this infrastructure. No new workflow service or integration platform. |
| Google | Gmail and Calendar connection; current scopes do not include Drive, Docs or Sheets | Drive and editor access are new integration work, not an already available capability. |
| Mail | Attachment metadata, short-lived allowlisted text extraction | No revision fingerprint index or asset matching is implemented. |
| Outbox | Person-sent, text-only drafts with uncertain-send reconciliation | Exact-version attachments require an explicit extension of the draft and send contract. |
| Evidence | Tasks can link mail, files or URLs | Extend evidence with precise version references and preservation state. |
| Stock | Counted items and count history; Shopify read-only quantities; stocktake/reorder workflow | Keep this limited feature distinct from the proposed external operational ledger. |
| Production | Custom batches, process models, movements and costing excluded | Domain schemas and templates (a brewery's batches, a workshop's jobs) remain outside Captain's core model. |
| Files | “Link to where those already live”; no file store | A metadata and review layer fits the intent, but its new tables and behaviours need a plan amendment. |
| Images / OCR | Current triage extracts only plain text and CSV; PDFs explicitly skipped. The current Sprite configuration disables image tools | Do not promise that existing inference can process the supplied photographs. |

Sources: [Google connector][captain-google], [Gmail connector][captain-gmail], [outbox implementation][captain-outbox], [stocktake runbook][captain-stock], [triage runbook][captain-triage], [inference runbook][captain-inference]. This was a source review, not a production integration test.

The current plan's §14 explicitly leaves printable production records open until requested. This discussion supplies that request. The recommendation is to resolve it with external business records and generic Captain evidence support.

### Embrace and retired systems

Embrace was inspected at **`6616cccc9c8e55a5f32aed7b2f77764d5a74147b`**, alongside its local planning additions. Its source includes file viewers and annotation interactions; its roadmap contains substantial additional ambition. A roadmap feature is not assumed to be shipped.

The transferable ideas are previewing files, selecting a version, attaching a note to a location in that representation, and seeing discussion in context. The current path/Lore identities, SQLite store, tailnet identity, proxy, local sync and agent runtime should not become Captain dependencies. Illustrator preview conversion is not assumed to exist just because an `.ai` file can be stored or fingerprinted. See [Embrace viewers][embrace-viewers] and [roadmap][embrace-roadmap].

**Fibery is no longer part of this system. Brewery OS has been shelved.** Neither is an integration target, authority, prerequisite or migration destination in this proposal. Earlier plans that depended on them are historical context.

## 3. Ownership and product boundaries

| Concern | Recommended owner |
|---|---|
| Working original, folders, ordinary file sharing, native edits | Google Drive and the user's existing applications |
| Working native spreadsheet/document | Google Sheets / Docs |
| The business's own operational ledger (for the brewery: items, batches, additions, readings) | Business-owned Sheets initially; a specialist system if complexity later warrants it |
| Projects, tasks, recurring duties, reminders and outbox | Captain |
| File identity, observed revisions, links to work, review notes | Captain metadata |
| Preserved source bytes | Drive retained revisions or explicitly created archival files in Drive |
| Interpretation of a scanned page | A bounded extraction step producing a draft, followed by a person's review |
| Financial general ledger and accounting entries | The accounting system; a stocktake workbook is not automatically an accounting general ledger |

An external operational record can be linked to a task. For the brewery that task is “Complete cellar note for Arrive 19”; for a joinery it might be “Finish the job sheet for the Smith kitchen.” Captain need not understand a fermentation state machine, or any other process model, to track that commitment.

The existing counted-stock feature should remain available. For a given stock category, choose one authority: Captain's counted list, a designated external workbook, or the commerce system. Do not have both Captain and a workbook independently own “the current count.” A later reviewed importer could record an accepted external count as an observation, with its source, but must not silently derive movements or overwrite Shopify quantities.

## 4. The everyday experience

### A designer editing an Illustrator file

1. The designer opens the usual `.ai` file from its usual Google Drive folder in Finder.
2. They save normally. Drive for desktop syncs the file as it does today.
3. Captain observes the cloud change and records the available provider revision. It does not claim to have captured every local save.
4. In Captain, a colleague opens the linked asset, sees the version and available preview, and leaves a note on that exact representation.
5. A person marks a specific version ready to use. Captain preserves it before displaying a successful ready state.
6. A later edit becomes a newer working version. It does not change the version already attached to a task or email draft.

### A supplier emailing an attachment

1. Gmail receives an `.ai`, PDF or other permitted attachment.
2. Captain fingerprints the decoded attachment bytes within explicit processing limits.
3. It compares that fingerprint with revisions already accessible in this organisation's file index.
4. The mail shows “Exact content match” with the matching file/version, “Several exact matches,” “No match in indexed versions,” or a reason it could not be checked.
5. An unmatched attachment remains a Gmail attachment. Saving it to Drive or treating it as a new version is a separate, deliberate action.

### Someone capturing a paper record

1. Print the day's record from a familiar template. For the brewery that is a stocktake sheet or a cellar note; for another business it is whatever page its kit defines.
2. Write on it at the point of work, including corrections and freeform observations.
3. Scan the completed page to a designated Drive folder using a phone or scanner.
4. A draft extraction appears beside the scan. A person fixes uncertain values and accepts the record.
5. The business's operational workbook receives the accepted rows. Captain links the scan and accepted record to the relevant task.

Nothing in these five steps is specific to brewing. The template, the reference lists and the validation rules are the business's own configuration in its own Workspace; Captain sees scans, review, acceptance and evidence links.

### Someone working inside Google Sheets

Open the Captain sidebar to see the linked project, outstanding tasks and saved evidence. “Attach this version as evidence” captures a specific representation. “Prepare an email with this version” opens a Captain draft. Editing the sheet remains a Google operation.

These flows require no `.revisions` convention, no symlink handling, no mandatory Captain desktop agent and no change to a colleague's ordinary editing application.

## 5. File identity and version semantics

### Use provider identities, not paths

A Captain file record should identify the organisation, provider and provider file ID. The connection records how access was obtained; it is not the file's permanent identity. Two authorised connections that see the same Drive file should not create two unrelated assets. Access grants remain separate and account-qualified.

Names, parents and paths are descriptive metadata. A rename or move can preserve identity; a copy or Save As can create a different identity. An application replacing a file can behave differently from one updating it, so test actual Illustrator/Finder saves before promising continuity. Never merge separate file IDs merely because names or checksums match.

Keep these concepts distinct:

| Concept | Meaning |
|---|---|
| File | The continuing provider object |
| Provider revision | A version identifier supplied by Drive for that file |
| Observation | Captain saw particular metadata at a particular time |
| Representation | Original bytes, an exported PDF, an image preview, or extracted text |
| Snapshot | A deliberately preserved representation with its own identity and checksum |
| Evidence link | A task or other record points to a particular version/snapshot |
| Ready-to-use version | A person's designation of a particular preserved version; separate from latest |

For uploaded binary files, `headRevisionId` can identify the head revision. Drive's `version` field is a server-side change counter; it is not interchangeable with a content revision ID. Native Google files have different revision and export behaviour. [Drive File resource][drive-files]

### Working history versus preserved evidence

Ordinary Drive history is useful working history, not an unlimited immutable archive. Google documents automatic pruning for unretained blob revisions, allows at most 200 `keepForever` revisions per file, and charges retained revisions against storage. A retained revision is protected from automatic pruning, not from every authorised deletion. [Revision management][drive-revisions-guide]

Captain should maintain two visibly different states:

- **Observed:** the revision was indexed, but continuing availability is not guaranteed.
- **Preserved:** the preservation operation succeeded, and Captain has recorded how to retrieve the selected representation.

Additional states should include preservation pending, unavailable, access removed, source deleted and preservation failed. “Preserved” must never be set just because metadata was inserted in Captain's database.

Use `keepForever` for selected uploaded-file revisions when possible. Monitor the limit; do not automatically retain every save or silently unpin older evidence to make space. Where a separate snapshot is necessary, copy the **selected revision's bytes** to an ordinary archive file and record the relationship. A generic “copy file” request must not accidentally capture a newer head.

Revision listing can omit older history, and API results are not guaranteed to reproduce everything visible in the editor's history UI. Current Drive documentation also places restrictions on downloading blob revisions, including retention requirements. Treat listing, preserving and downloading the selected revision as independently checked operations. [Revision resource][drive-revisions], [download guide][drive-downloads]

An archive folder should have explicit permissions and retention rules. Hiding a folder, naming it `.revisions`, or setting a read-only content restriction does not make it an immutable records archive. Stronger tamper-resistant retention would require a separate future storage decision.

### Why not a hidden revision tree and a “latest” symlink?

| Approach | Assessment |
|---|---|
| Normal working file plus Drive revisions | Recommended starting point. Fits Finder and native applications; preserves provider identity where saves update the same object. |
| Normal working file plus selected archive snapshots | Recommended supplement where long-lived evidence cannot rely on a provider revision alone. |
| Archive files plus a visible symlink to the newest one | Reject as the default. An edit may modify the archived target, and replacement-style saves may replace the link itself. It also makes local filesystem semantics part of the product contract. |
| Drive shortcut to a “latest” object | Useful navigation, but not a local VCS or a moving immutable-version pointer. A Drive shortcut targets another Drive file. |
| Captain-managed local folder and sync daemon | Defer. Introduces installation, conflicts, upgrades and support into the very workflow this proposal is trying to simplify. |

Native applications differ in their safe-save and replacement behaviour; a universal filesystem interception promise is not justified. No native macOS editing hooks are required in the recommended design. [Apple document model][apple-documents], [Drive shortcuts][drive-shortcuts]

Offline edits are visible to Captain only after they reach Google. Multiple local saves may become fewer cloud revisions. The interface should say “Last observed in Drive” rather than imply a complete local edit history.

## 6. Matching Gmail attachments to files and revisions

An ordinary email attachment does not carry an authoritative Drive file ID and revision ID. Matching must compare content and then resolve the matching records.

Recommended process:

1. Resolve the Gmail message, MIME part and attachment reference in the connected account. Handle attachments whose data is present in the message as well as those requiring `messages.attachments.get`.
2. Decode the transfer representation and calculate SHA-256 over the actual attachment bytes. Hashing base64 text would give the wrong identity.
3. Search the organisation's authorised revision/representation fingerprint index. Use file size and existing checksums to narrow candidates.
4. For historical versions without SHA-256, use available metadata as a candidate filter, then retrieve and hash the precise revision when access and retention permit. MD5 alone should not establish an adversarially robust match.
5. Record the result with Gmail account/connection, message and part, compared revision, algorithm, digest, time and matching method.

Drive can expose SHA-256 for uploaded content, but older revision metadata does not give a universal searchable SHA-256 index. Captain must build its own bounded index; there is no assumption of an API that searches every historical revision by attachment bytes. [File metadata][drive-files], [revision metadata][drive-revisions], [Gmail attachment API][gmail-attachments]

Use precise language:

| Result | What it establishes |
|---|---|
| One exact byte match | The attachment's content matches an indexed representation. |
| Multiple exact matches | Several files/revisions contain the same bytes; content alone cannot distinguish their provenance. |
| No indexed match | No match was found within the indexed, accessible coverage. It does not prove the file never existed in Drive. |
| Unchecked | Unsupported size, unavailable revision, missing permission, incomplete indexing or a processing failure. |

Renaming a file does not change its bytes. Re-saving an Illustrator document can change its bytes even if it looks the same. Visual similarity, filenames and an LLM's judgement may suggest candidates later, but must not be labelled exact matching. Matching an `.ai` also says nothing about external linked images, fonts or whether the file is print-ready.

Identical content can recur in multiple revisions or files. Do not automatically attach the sender's email to one supposedly unique source, overwrite a file, or infer a trustworthy author from a checksum. Matching must not expose the existence of files outside the actor's authorised scope, including other tenants.

This deterministic service should be separate from text extraction. It can fingerprint an `.ai` without interpreting Illustrator's file format or sending it to a model. Metadata and hashes can be retained; bytes should be processed transiently under bounded memory, size, concurrency and time limits. Hashing and MIME assembly run on the API's 1 GB machine, so both must stream rather than buffer, and the size cap and concurrency limit are slice C acceptance items.

## 7. Exact-version attachments and correspondence

The current Captain outbox has no attachment manifest. Add one before offering “Send this version.” Each entry needs a selected representation, source file/revision where applicable, preservation locator, filename, MIME type, size and SHA-256.

The version becomes fixed when attached to the draft. If the source changes, the draft still points to the selected version. The person may explicitly replace it with a newer version; Captain must not do that automatically.

Before starting a send attempt:

1. Recheck the person's membership, sending account and source access.
2. Retrieve the exact representation, verify its digest and enforce the combined MIME/message size limit.
3. Make the reviewed attachment list, recipients and body part of the send intent. Freeze them once an attempt begins.
4. Reuse the existing stable Message-ID and uncertain-send reconciliation. An ambiguous network result must not trigger a fresh send with different bytes.
5. Record the provider message ID and the sent attachment manifest as the receipt.

A missing or changed source produces an actionable error before sending. It never falls back to the latest revision. The preservation design should let a draft survive ordinary source edits; it cannot guarantee access after the owner revokes or deletes the source and all retained copies.

The API, not the inference Sprite, prepares and sends the MIME message through the existing Gmail connector. This intentionally supersedes the earlier Embrace idea of using a Sprite as a general artifact/email runtime: current Captain's Sprite is inference-only.

People may continue sending directly in Gmail. Captain can match observed Sent attachments afterwards, with honest coverage limits. That provides evidence of what was sent without requiring everyone to adopt Captain's composer.

No workflow sends mail. The existing outbox remains the person's final send surface. Readiness, extraction review and outbox draft states are ordinary application states, not a new signed-proposal or confirmation-token framework.

## 8. Bringing Embrace's useful UI into Captain

### Initial placement

Keep the five top-level tabs. Add a **Files** view within a project under Commitments, accessible from task evidence and Inbox attachments. A cross-project file list can live within Commitments if real usage warrants it. Settings holds Drive connections and indexing controls.

The initial file detail should contain:

- File name, location, source application link, access/sync state and last observed time.
- A supported preview, with an explicit “Open original” action.
- Version history distinguishing latest working, selected and ready-to-use versions.
- Linked tasks, messages, projects and evidence.
- Notes and, later, annotations anchored to the selected representation.

Start with image and PDF previews plus safe plain-text display. Video time anchors and more elaborate viewers should follow demonstrated use. For unsupported formats such as an Illustrator file without a usable preview, show its metadata and open/download action. A preview derivative is separate from the original, with its generating source/version recorded.

### Review semantics

Annotations must include the selected version and representation. A PDF region needs a page and coordinate convention; an image region needs dimensions or normalised coordinates; a text anchor needs a quote/context or source range. Carrying an old comment onto a new rendering should be an explicit proposed relocation, not a silent move.

Keep lightweight file review distinct from a general team chat product. A note can create a linked task through an ordinary audited action. It does not invoke an autonomous agent with write tools. “Ready to use” is a person's designation, not an inference verdict or an external publishing action.

The current Captain repository prohibits importing code/design from other projects and names its own design system as authoritative. Therefore the first implementation should **recreate the selected Embrace interactions in Captain's components**. If direct source reuse is desired, propose a narrow exception identifying the exact modules, licences, dependencies, accessibility work and security review. Do not transplant Embrace's server or entire overlay unnoticed.

### Shelving Embrace safely

Before retiring the running system, inventory existing originals, Lore revisions, users, notes and anchors. Export a manifest, preserve referenced historical representations and map identities deliberately. Keep original Lore identifiers as provenance; do not pretend they are Drive revision IDs. Verify migrated notes against the actual preview they refer to.

Retain a readable archive and a tested recovery path until migration is accepted. The absence of a stable Lore API makes this a bounded export task, not a reason to build a permanent Lore connector. This proposal itself performs no retirement or migration.

## 9. Native Google documents and offline work

Treat a native Google document as an editable provider object with exportable representations. A PDF or XLSX export is a representation of that document, not its native file bytes and not necessarily a reversible, complete copy of its history.

For evidence, capture the chosen document revision where the API supports retrieving/exporting it, then record revision, export MIME type, export settings, timestamp and checksum. Google's download API supports revision selection for certain types, including Docs and Sheets, but this is not a promise that every revision shown in the UI remains retrievable. Prove the intended export operation during the spike. [Download API][drive-files-download]

If the selected historical export is unavailable, show that state. A person can deliberately capture the current document as a **new** evidence snapshot. Never claim it represents the earlier version. UI named versions are useful to people, but should not be treated as an API retention or immutable snapshot mechanism. [Google version history][google-history]

For a record close (a stocktake, an inspection round), preserve both a human-readable PDF and machine-readable accepted rows where needed. The PDF proves what a person saw; structured rows support later reporting. Record the workbook, tab/sheet ID, record ID and extraction/acceptance identifiers. A row number or A1 range alone is not a durable record identity after sorting and insertion.

On macOS, supported Google Docs/Sheets offline editing is through Chrome or Edge with Google's offline setup and selected files made available in advance. Changes sync after reconnection. A browser-installed app window can make this feel like a desktop application, but it uses the browser's profile and storage. A Finder entry for a native Google document is not an ordinary locally editable `.docx` or `.xlsx`. [Google offline instructions][google-offline], [Chrome app windows][chrome-apps]

Do not promise offline Captain sidebar actions. Even when the editor is available offline, Captain's API, task writes, snapshot capture and inference need a connection. The sidebar should say so; normal document editing can continue. No automatic cross-account or cross-browser offline support is assumed.

## 10. Captain sidebar inside Docs and Sheets

### Recommended first surface

Use a **Google Workspace Add-on** with a small card-based sidebar shared across Docs and Sheets. Its first job is context and a few actions, not reproducing the whole Captain interface. [Workspace editor interfaces][editor-interfaces]

An Apps Script Editor add-on can offer richer HTML sidebars if later interaction requirements justify that route. Do not choose it merely to embed the entire Captain web application. Google's Workspace and Editor add-on mechanisms have different UI and authorisation models. [Workspace extensibility][google-extend], [Editor add-on interfaces][editor-html]

The initial sidebar should show:

| Surface/action | Behaviour |
|---|---|
| Current file | Show its recognised Captain file and linked project, after file access is granted. |
| Linked work | List a bounded set of relevant tasks and evidence links. |
| Link to task/project | An ordinary membership-checked Captain write. |
| Create task | Person supplies or reviews title, owner and due date; use existing task semantics. |
| Attach version as evidence | Request preservation; show pending/succeeded/failed and link to the result. |
| Prepare correspondence | Create a Captain outbox draft with a fixed representation, then open Captain for review/send. |
| Open Captain | Deep link to the same file, project or task. |

Later, bounded “summarise this document” or “suggest tasks from this selected content” actions may invoke an existing-style infer step. Selection support must be verified for the chosen add-on host; whole-document access must not be silently substituted for a requested selection.

### Identity, access and deployment

Authenticate the person to Captain, map a verified identity to an active membership, and make the selected organisation visible. Do not trust an organisation ID or email address supplied by the sidebar as authority. Captain's existing second-factor and session policy should remain effective; use a browser sign-in/deep-link flow where the host cannot satisfy it directly.

Request access to the current file explicitly. Google provides `drive.file` grants and an `onFileScopeGrantedTrigger` for relevant add-on flows. The Apps Script `documents.currentonly` and `spreadsheets.currentonly` scopes do **not** grant the backend equivalent REST API access: they are restricted to Apps Script Services. Keep the add-on's host permission, Captain session and backend provider connection distinct. [Add-on scopes][workspace-scopes]

A minimal Apps Script/card adapter can call the existing Captain API; business decisions stay in Captain services. Name the adapter and any dependencies in the main plan before implementation. Pilot within the first business's Workspace first (the brewery). Public distribution, OAuth verification and any restricted-scope review are separate release gates, not implied by a successful private prototype.

## 11. Operational records outside Captain: a kit of generic parts

Captain has no configurable domain model (plan §12): no entity types, custom fields, units or process definitions. A business's operational records therefore live outside Captain, in the business's own Workspace, built from parts that are the same for every business. What differs per business is configuration: which record types exist, what each page asks for, which reference lists it draws on, and which validation rules apply. This section describes the parts, how a workflow is assembled from them, and then the brewery's assembly as the worked example.

### The parts

1. **Reference lists.** A business-owned Sheet holding the stable IDs a record can refer to: the things being counted, made, inspected or worked on, and the places it happens.
2. **Record templates.** One printable template per record type, with a PDF for consistent printing, carrying a record ID, page ID and template version.
3. **A scan location.** A Drive folder for incoming scans and for preserved accepted evidence.
4. **A review step.** A simple review screen or Sheet-based review before a draft becomes an accepted record.
5. **An acceptance destination.** An accepted-rows ledger in the workbook, written idempotently under a stable acceptance ID.
6. **Captain around it.** Tasks, series, reminders, evidence links and the record's place in Commitments.

Start with manual review and entry. Add extraction after a representative test set exists. This gets the working process right before investing in handwriting automation.

### Assembling a workflow from the parts

A business assembles its kit in this order, and none of it is Captain code:

1. **Name the record types.** Each is a thing that happens repeatedly and produces values worth keeping: a count, a production step, an inspection, a job sheet.
2. **Give each record type a template.** Decide the fixed fields (who, when, where, against which reference), the repeated rows (items, additions, readings), whether continuation pages are needed, and where freeform notes go.
3. **Decide the row shape** in the acceptance destination (below), so the same rows serve reporting later.
4. **Write the validation rules** for each template: required fields, units, allowed references, and which ambiguities must stop acceptance.
5. **Put the Captain pieces around it.** A recurring series for the record when it is periodic, a task per instance when it is not, and evidence links from the accepted record back to the scan.

Captain's contribution is the same for every kit: the scan lands in Drive, a draft extraction (once it exists) is reviewed, the acceptance is recorded, and the evidence is linked to a task. The schema is the business's; the review and evidence envelope is Captain's, and it is small and generic.

### Spreadsheet shape

One column per occurrence (one column per stocktake, one per inspection round) is a reasonable **working view**, but a poor long-term storage model. Keep accepted data as rows: record ID, subject reference (the item, batch or job), location, value, unit, recorded time, recorder, accepted time, reviewer and source page. Generate the familiar date-column matrix from those rows. For a stocktake the subject is the item and the value is the count; for a reading the subject is the batch and the value is the measurement.

Use business-owned reference tabs for stable subject and location IDs. Units should be explicit; automatic conversions need separately tested business rules. Blank, not recorded and zero must be distinct values.

The proposed checkbox can request “close record” (for the brewery, “close stocktake”). An authorised installable Apps Script trigger can validate the values, write an accepted snapshot, record the closer and apply a protected range. A simple edit trigger should not be assumed to have the permissions needed for all of those operations. Protection prevents many accidental edits; spreadsheet owners can still change protected data, so it is not an immutable audit record. Programmatic/API edits need an explicit close path because they do not simply reproduce a person's edit-trigger flow. [Apps Script triggers][apps-script-triggers], [Sheets protection][sheets-protection]

Keep the accepted row ledger and snapshot independent of that column's lock. Corrections create a documented correction or superseding accepted record. Do not erase the earlier accepted result. If “general ledger” means an accounting ledger, design a separate validated handoff to the accounting system; stock counts alone are not accounting postings.

An installable trigger runs as its creator, who is not necessarily the person checking the box. Record execution identity separately from the counted-by/closed-by identity, and use an authenticated close action if the editor cannot be reliably identified. Serialise closing, re-read the input and use a stable acceptance ID so a double-click or retry cannot create two accepted records. [Trigger execution identity][apps-script-triggers]

This workbook automation belongs to the business's external kit. It is not a general custom-schema/process designer inside Captain.

### Worked example: the brewery's kit

The brewery is the first business to assemble the kit, so its assembly is written out here as the example. Its record types are a stocktake, a brew day, fermentation readings and blending or finishing. Its reference lists are items, locations and batches. Its Captain pieces are a recurring stocktake series and a task per batch.

The review looked at four photographs of the brewery's current paper records, which are not in this repository: a brew-day sheet with ingredients and planned steps, recorded times/temperatures/volumes, fermentation readings continuing onto another page, and a separate blending note. They contain ticks, cross-outs, overwritten quantities, ditto marks and marginal observations. A template must preserve room for those realities; slice F assembles a test set from real pages, so the photographs need not be committed here.

Use a family of pages rather than one densely compressed universal form. The brewery's family is:

- **Stocktake:** location, item/reference, unit, count, not-counted marker and notes.
- **Brew day:** batch/reference, recipe/template version, planned ingredients alongside actual additions, process readings and freeform exceptions.
- **Fermentation continuation:** repeated batch identity, date/time, gravity, temperature, pH, additions and observations.
- **Blending/finishing:** source batch/reference, additions, quantities, actions and observations.

Every page should carry a human-readable record ID, page ID, template version and optional QR code encoding opaque identifiers, not credentials. Continuation pages repeat the batch identity. Leave generous writing space, clear units and an unstructured notes area. Print planned values separately from blank actual fields so a tick or an unfilled cell cannot be mistaken for a measured quantity.

Use paper and suitable writing materials for the working environment (for the brewery, a wet cellar); test legibility after the handling the pages will actually get. Capture a flat, well-lit scan before filing the original. The supplied pages are examples to interpret, not instructions for Captain or the extraction model to execute.

### Extraction and acceptance

The pipeline should be:

`scan in Drive → identify page/template → draft extraction → deterministic validation → human review → accepted external rows + evidence link`

Store the source representation, page association, extractor/schema version, candidate values, ambiguity flags, reviewer corrections and acceptance identity. A model's confidence number is not enough: show uncertain cells and the corresponding source region. Keep freeform notes as notes; do not force every sentence into an operational event.

Validation must catch missing pages, conflicting record IDs, unrecognised items, ambiguous dates, missing units, decimal/handwriting ambiguity and duplicate ingestion. Cross-outs and ditto marks should be flagged when their meaning is uncertain. Planned amounts are not actual consumption. A blank is not zero. An apparent reading on a continuation page is not safe to attach to a record merely because the previous image looked related.

Accept records explicitly, then write them idempotently. Use a stable acceptance ID in the destination and verify it after uncertain results; Google Sheets writes are not assumed to be exactly-once transactions. Record corrections as new revisions of the accepted record. The same scan, re-uploaded or retried, must not double a count or addition.

The schema for the business's fields (the brewery's gravities and additions, another business's own measures) belongs to the external kit. Captain may own a small generic review/evidence envelope, but should not acquire arbitrary custom entities by storing an unbounded “anything” payload and building a domain editor around it.

### Inference gap and recommendation

Today's Captain inference path is text-only at its application boundary and is deliberately constrained. The paper pilot therefore needs its own capability decision:

- First test whether a bounded image-input extension can retain the existing subscription-based, data-only contract without enabling tools or a general filesystem workspace.
- If that cannot be supported reliably, choose a narrowly scoped OCR/document-extraction service or an explicitly approved API-based multimodal adapter. That needs a named connector, data policy, budget model and plan amendment; it must not silently activate the deferred API-key path.
- Keep the pilot manual while this is unresolved. Do not make the file/asset foundation depend on OCR.

Image resizing, decoding and PDF handling need resource limits and safe processing. Source images remain in Drive; any temporary processing bytes are deleted promptly and excluded from logs, prompts retained in journals, backups and model conversation history. The immutable journal should store references/digests and outcomes, not a second copy of every scan.

## 12. Options considered

| Option | Fit for this business | Recommendation |
|---|---|---|
| Drive + Sheets + printable templates | Uses existing accounts, Finder and familiar tools; requires careful IDs, review and snapshot handling | Start here. |
| Docs/Sheets Captain sidebar | Makes task/evidence actions available where people edit | Add after file identity and preservation work. |
| Google Forms | Useful for simple online submissions and uploading a scan; less suited to flexible repeated row tables such as ingredients or readings | Optional capture door, not the primary record editor. |
| AppSheet over the workbook | Candidate for structured entry/review if spreadsheet entry becomes awkward | Evaluate later against the actual row model, offline requirements and account licensing. |
| Airtable | Candidate if related records and business-facing review screens justify another system | Defer until the Workspace pilot demonstrates a concrete limitation. |
| Baserow / NocoDB or another database front end | Candidate if ownership, portability or SQL-backed relationships become the priority | Adds administration; not necessary for the first kit. |
| Specialist domain software (for the brewery, brewing or manufacturing software) | Appropriate if traceability, lots, costing, scheduling and movement-led inventory become central | Prefer this over gradually turning Captain into an operations system for any one domain. |
| General document/OCR service | Could improve extraction of forms and handwriting | Select by testing real wet/corrected notes; it does not remove the need for review. |
| Lore-backed Embrace | Offers an explicit asset/version system, but adds a separate backend and user integration | Shelf as the forward architecture after a safe archive/export decision. |
| Hidden snapshots and local symlinks | Attempts to provide custom versioning while disguising it as normal files | Reject as the default user workflow. |

These are architecture choices, not a current pricing or feature benchmark of every alternative. No recommendation depends on an unverified promise about an alternative product's offline support. Before purchasing one, test the business's own representative record workflow against it (for the brewery, a stocktake and a cellar note).

## 13. Proposed technical shape

### Services and data

Extend the existing API, connectors, database and UI packages. Add no separate asset server, workflow engine or permanent local agent.

The following are **proposed logical records**, not existing tables or a final migration specification:

| Record | Purpose / essential identity |
|---|---|
| `external_files` | Organisation + provider + provider file ID; type, title, location, observed state |
| `external_file_access` | File + connected account/member or explicitly shared business access; verification state |
| `external_file_versions` | File + opaque provider revision ID where available; observed metadata, digest, availability |
| `file_representations` | Version/snapshot + MIME/export profile, size, SHA-256, provider locator and preservation state |
| `file_links` | File or fixed representation → project, task or message; explicit live versus fixed semantics |
| `file_reviews` / `file_annotations` | Selected representation, author, ready-state or anchor/note; version-qualified |
| `attachment_matches` | Gmail message/part + representation; exact/candidate outcome and matching method |
| `outbox_attachments` | Draft + fixed representation manifest; included in frozen send intent |

Reuse or extend `evidence`, `connections`, cursors and audit records rather than making parallel versions. Any generic scan review record should arrive with the later pilot, not be prebuilt as a speculative form platform.

All tenant records require forced RLS and tenant-qualified foreign keys. File access is an additional rule: belonging to the same Captain organisation must not automatically disclose every private file visible to one member's Google account.

For the first pilot, restrict indexing to deliberately enrolled business files and a documented shared-access policy. Personal files should require the acting person's access, or an explicit decision to share the record with the organisation. Listing metadata, revealing matches, generating previews and serving bytes all need the same access boundary. Revalidate provider permissions at sensitive actions and expire/revoke cached access; describe the residual delay of cached listings honestly.

Export should include the metadata manifest, source/version identities, relationships and annotations without credentials. Deleting a Captain organisation should remove its Captain records and revoke connections; it must not delete the customer's working Drive files. Provider-side archive files created by Captain need an explicit ownership and cleanup policy rather than an automatic cascade. A user can unlink a file without deleting its original.

File-aware answers should be a later extension of the existing bounded answer-source selector: only enrolled, authorised records, with version-qualified citations and visible freshness/coverage. Connecting Drive must not silently send a whole library to inference or introduce unrestricted model-driven search.

### OAuth and discovery

Start with explicit file selection and `drive.file` where it satisfies the workflow. It grants technically writable per-file access, so enforce read-only behaviour in application code until a preservation action is requested. Existing Google login/Gmail consent does not automatically grant Drive access: adding it is incremental consent on the organisation's existing Google connection, so the `connections.scopes` record and the reconnect flow change, rather than a second connection being created.

Automatic discovery across an existing folder tree may require broader scopes, such as restricted Drive read access. Selecting a folder is not assumed to recursively grant `drive.file` access to every existing child. Prove that behaviour and decide separately whether the convenience warrants broader consent and verification obligations. Enforce application-level folder boundaries even when the OAuth token is broader. [Drive scope guide][drive-scopes]

Drive changes notifications are hints to consume the change feed, not a journal of every file save. Persist cursors, renew expiring notification channels, deduplicate jobs and reconcile after gaps. A periodic poll/manual refresh provides recovery. Index only available permitted content, and support shared-drive parameters when the pilot uses a shared drive. [Change feed][drive-changes], [push notifications][drive-push]

Use housekeeping routines for indexing, retention checks and cache cleanup. Use the existing typed workflow runner only for business sequences such as requesting review, waiting and notifying. Queue payloads carry opaque IDs; provider calls recheck current authority. Reconnect, quota exhaustion, lost permission and expired cursors should have explicit, recoverable states.

### Storage and cost

Keep original and preserved bytes in the customer's Drive. Captain stores metadata, checksums, links and bounded derived text. First-party API streaming or short-lived processing is still bandwidth and compute work; this is not a zero-cost architecture.

Costs to measure are retained Drive revisions/snapshots, API and outbound transfer, preview generation, database metadata, extraction calls or subscription usage, and support for permissions/sync failures. Do not import the earlier Embrace assumptions about Tigris delivery or Sprite bandwidth into this plan. Captain's existing Tigris database-backup use does not make it an approved asset store.

Do not add a persistent thumbnail, attachment or OCR-byte cache as an invisible implementation detail. Such a cache would need explicit retention, deletion/export behaviour and a D13 amendment. Initial previews can use authorised provider delivery where suitable, or bounded authenticated streaming. Unsafe active content must not execute under Captain's origin; previewing is not permission to run a document's scripts.

## 14. Required changes to Captain's plan

Before implementation, make a reviewed update to the live `docs/plan.md` and repository instructions. The standalone proposal does not itself amend them.

| Existing decision / section | Proposed treatment |
|---|---|
| D1, six jobs | Keep. Tie file work to correspondence, evidence, review commitments and sourced answers. |
| D2, data-only inference | Keep. Any extraction is schema-constrained input/output with no tools or credentials. |
| D3 / D19, workflows and pg-boss | Keep. Name new steps/routines and handlers; no additional engine. |
| D4, enabling-person authority | Keep, with current provider access and membership rechecks. |
| D5, person sends | Keep. Add fixed attachment manifests and extend existing send reconciliation. |
| D6, RLS | Keep and extend to every new record; add file-level visibility rules. |
| D8, first-party integrations | Extend the Google connector to the named Drive and add-on operations. No Nango or generic integration platform. |
| D9 / D18, subscription inference | Keep for initial file work. Any multimodal extension/API alternative gets a separate explicit decision before the paper automation phase. |
| D11, five tabs | Keep; file views are nested/contextual. A top-level Files tab would require a separate product decision. |
| D13, attachment bytes | Preserve no durable Captain byte storage. Explicitly document transient fingerprinting, preview and MIME assembly limits. Any persistent derived-byte cache needs a later amendment. |
| D14, design authority | Keep. Recreate useful Embrace interactions using Captain design; identify any narrowly approved source-reuse exception. |
| D15, counted stock | Keep. Clarify the single authority per stock category and separation from the business's external operational records. |
| §5 / §8, data and integrations | Add the selected logical records, scopes, provider operations and access policy. |
| §12, no file store / documents / team chat | Clarify a bounded file-reference, evidence and review layer; originals and editing remain external. No general chat or document editor. |
| §14, printable records | Resolve: external business-owned templates and records; Captain tracks commitments/evidence. Extraction is a later scoped capability. |

The current second-customer readiness work remains a prerequisite for broader rollout. This feature should not displace tenant isolation, backup/restore, export/deletion, terms/privacy or support work.

## 15. Delivery sequence and acceptance gates

Each slice should be independently useful. These are proposed slices, not calendar estimates or approved engineering tickets.

### A. Prove the provider contract

Use a small test folder with an `.ai`, PDF, image, Doc and Sheet. Exercise normal edits, rename, move, Save As, a replacement-style save, offline editing/resync, permission removal, deletion and reconnect. Record which operations preserve file IDs and which revisions remain downloadable.

Prove selected blob revision retention, a selected native-document export, the per-file consent flow, shared-drive behaviour if used, and duplicate attachment matching. Test the actual Google Drive for desktop/Finder setup and Illustrator version used by staff.

**Exit:** a concise evidence report with supported behaviour and limits. If exact selected-revision retrieval cannot be proven, do not ship a “fixed evidence” promise around that operation.

### B. Selected files and fixed evidence

Amend the plan; add Drive connection/file selection, metadata, a minimal contextual file view and task evidence. Implement preservation for the supported representations, with unavailable/pending/failed states and export/deletion coverage.

**Exit:** a task keeps the same selected evidence after the working file changes; unauthorised members cannot see metadata or bytes; provider revocation is handled; a retry cannot create an unbounded set of snapshots.

### C. Attachment matching and person-sent attachments

Add bounded fingerprinting, exact/ambiguous match display and the outbox manifest. Extend MIME assembly and the current send-intent/reconciliation tests.

**Exit:** renames still match; equal bytes in several revisions remain ambiguous; a changed source cannot alter a prepared attachment; a lost send response does not send a second message; access failures never trigger latest-version fallback.

### D. Embrace-style review and retirement decision

Add supported previews, version selection, version-bound notes and ready-to-use designation. Pilot with real artwork. Inventory and export any existing Embrace records that must survive.

**Exit:** users can review the right representation without learning a new file-saving process; note anchors never silently drift; migrated evidence is inspectable; Embrace retirement is separately accepted before services are stopped.

### E. Docs/Sheets sidebar

Build the small add-on adapter, identity/organisation selection, current-file linking and task/evidence actions. Deep-link to Captain's outbox for send review.

**Exit:** the same permissions and services govern sidebar and web actions; multi-account/multi-organisation cases are tested; offline unavailability is clear; native document editing remains usable without the add-on.

### F. External paper-record pilot

Assemble the kit for the first business (§11): the brewery's workbook, reference lists and template family. Run at least one manual cycle of each record type (for the brewery, one stocktake and one production cycle) through scan, review and accepted records. Assemble a test set from real staff handwriting, including wet pages, corrections, continuation pages and duplicate scans. Then choose and test the bounded extraction capability.

**Exit:** every accepted value has inspectable evidence; uncertain critical fields require review; duplicate retries do not duplicate destination records; the review process takes less effort than manual transcription; a second business could assemble its own kit from the same parts without new Captain code. Keep extraction advisory until those conditions are demonstrated.

## 16. Failure cases that must be visible

| Situation | Required behaviour |
|---|---|
| File edited locally but not synced | Show last observed cloud state; do not infer the local contents. |
| New cloud revision arrives during preservation | Preserve the selected revision or report failure; never silently select the new head. |
| Revisions omitted/pruned before indexing | Show incomplete coverage; do not claim complete history. |
| `keepForever` limit reached | Explain the limit and offer a deliberate archive/retention decision. |
| File copied or replaced with a new ID | New identity pending explicit association; name/hash is not sufficient to merge. |
| Same attachment bytes match several files | Show multiple matches without inventing provenance. |
| Ready artwork is edited again | Keep readiness attached to the selected version; latest is a separate state. |
| Native export differs by format/settings | Record the representation; do not compare it as native document bytes. |
| Provider access revoked | Block retrieval/actions, invalidate cached access and retain only permitted tombstone/audit information. |
| An annotation's representation is unavailable | Show the limitation; do not move it onto an unrelated current preview. |
| OCR cannot distinguish 1.017 from 1.077 | Flag the field and show the source; do not silently choose. |
| Spreadsheet write response lost | Reconcile the acceptance ID before retrying. |
| Source contains instructions to change workflow or expose data | Treat them as untrusted document content; infer steps have no authority to execute them. |

## 17. Decisions recommended for approval

1. Adopt Drive as the first provider for files kept in their existing locations, with no mandatory Captain sync client.
2. Put the bounded file/reference/review experience in Captain, adapting Embrace's useful interactions under Captain's design system.
3. Prefer ordinary working files and selected preserved versions over a hidden symlink revision system.
4. Distinguish working history, fixed evidence and ready-to-use versions; fix outgoing attachments to exact representations.
5. Use deterministic byte matching for Gmail attachment identity, with explicit ambiguity and indexing coverage.
6. Add a Captain sidebar in Docs/Sheets after the underlying file/evidence services, without embedding Google's editor in Captain.
7. Keep each business's own operational records in a Workspace kit assembled from generic parts, with the brewery as the first assembly; pilot manual paper capture before automating extraction.
8. Preserve the current administrative product, five tabs, first-party connectors, data-only inference and person-sent outbox. Treat any necessary exception as a named plan decision.

The first engineering action after this direction is accepted should be **slice A plus the live plan amendment for slice B**, not a wholesale Embrace port or a production OCR pipeline.

## Sources and review notes

Repository links below are pinned to the inspected commits so the proposal remains reviewable after main changes. Google/Apple documentation was checked during this review; provider behaviour still needs the live acceptance spike. No runtime was deployed or tested by writing this document.

[captain-plan]: https://github.com/SomedaySomehowBeer/askthecaptain/blob/702ce6fd96e3c7ea8088ede33b47ab3e184057f4/docs/plan.md
[captain-agents]: https://github.com/SomedaySomehowBeer/askthecaptain/blob/702ce6fd96e3c7ea8088ede33b47ab3e184057f4/AGENTS.md
[captain-google]: https://github.com/SomedaySomehowBeer/askthecaptain/blob/702ce6fd96e3c7ea8088ede33b47ab3e184057f4/packages/connectors/src/google.ts
[captain-gmail]: https://github.com/SomedaySomehowBeer/askthecaptain/blob/702ce6fd96e3c7ea8088ede33b47ab3e184057f4/packages/connectors/src/gmail.ts
[captain-outbox]: https://github.com/SomedaySomehowBeer/askthecaptain/blob/702ce6fd96e3c7ea8088ede33b47ab3e184057f4/apps/api/src/triage/outbox.ts
[captain-stock]: https://github.com/SomedaySomehowBeer/askthecaptain/blob/702ce6fd96e3c7ea8088ede33b47ab3e184057f4/docs/runbooks/stocktake.md
[captain-triage]: https://github.com/SomedaySomehowBeer/askthecaptain/blob/702ce6fd96e3c7ea8088ede33b47ab3e184057f4/docs/runbooks/inbox-triage.md
[captain-inference]: https://github.com/SomedaySomehowBeer/askthecaptain/blob/702ce6fd96e3c7ea8088ede33b47ab3e184057f4/docs/runbooks/inference-sprite.md
[embrace-viewers]: https://github.com/SomedaySomehowBeer/embrace/blob/6616cccc9c8e55a5f32aed7b2f77764d5a74147b/server/viewers.mjs
[embrace-roadmap]: https://github.com/SomedaySomehowBeer/embrace/blob/6616cccc9c8e55a5f32aed7b2f77764d5a74147b/ROADMAP.md
[drive-files]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files
[drive-revisions-guide]: https://developers.google.com/workspace/drive/api/guides/manage-revisions
[drive-revisions]: https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions
[drive-downloads]: https://developers.google.com/workspace/drive/api/guides/manage-downloads
[drive-files-download]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/download
[drive-shortcuts]: https://developers.google.com/workspace/drive/api/guides/shortcuts
[drive-scopes]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[drive-changes]: https://developers.google.com/workspace/drive/api/guides/manage-changes
[drive-push]: https://developers.google.com/workspace/drive/api/guides/push
[gmail-attachments]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages.attachments/get
[google-history]: https://support.google.com/docs/answer/190843?hl=en
[google-offline]: https://support.google.com/docs/answer/6388102?co=GENIE.Platform%3DDesktop&hl=en
[chrome-apps]: https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DDesktop&hl=en
[google-extend]: https://developers.google.com/workspace/extend
[editor-interfaces]: https://developers.google.com/workspace/add-ons/editors/gsao/building-editor-interfaces
[editor-html]: https://developers.google.com/workspace/add-ons/guides/editor-style
[workspace-scopes]: https://developers.google.com/workspace/add-ons/concepts/workspace-scopes
[apps-script-triggers]: https://developers.google.com/apps-script/guides/triggers/installable
[sheets-protection]: https://support.google.com/docs/answer/1218656?hl=en
[apple-documents]: https://developer.apple.com/documentation/appkit/nsdocument?language=swift
