# Contacts and companies

Jobs: triage the inbox; brief and answer. Decisions: D2 (data only, no inference here), D6
(tenant isolation), D8 (our Google connector), D11 (the existing Inbox and Settings tabs).

Migration `0006_contacts.sql` adds contacts and companies with forced RLS and composite tenant
references. It also retains Gmail-provided Bcc headers and gives mail threads a tenant-qualified key.
Deleting cached mail clears a contact's last-thread link; it does not delete the contact.

Every successful mail sync backfills contacts from all currently cached From, To, Cc and Bcc headers.
Contacts, mail changes and the Gmail cursor commit together. No extra scheduler or network request is
needed. Existing cached messages acquire Bcc only when Gmail returns the thread again.

- The connected account and obvious automated senders are excluded. Parsing, no-reply rules and the
  shared mailbox domain list are in `apps/api/src/contacts/addresses.ts`.
- Business domains become companies named after the domain; Captain does not guess a business name.
  Shared mailbox domains do not become companies. Members can rename companies in Settings.
- A hand edit sets `source = hand`. Sync preserves hand/import names and company choices, all roles,
  phones and notes, and archived records. It updates first/last seen and the last-thread reference.
- `contacts.synced` audits the system run with address, created, updated and company-created counts;
  audit details contain no headers or message bodies. Failed runs roll back and follow the mail sync
  failure path. Existing hand contacts are enriched on the next successful mail sync.
- Recent threads are up to 20 exact email matches in currently cached mail, excluding disconnected
  accounts and replaced account caches. This is not a complete correspondence history.

All active members can read and edit `/contacts` and `/companies`. Search accepts `q` and `limit`
(1–200); lists return `hasMore`. Email/domain conflicts return 409. Contacts and companies archive via
`PATCH {"archived":true}` and restore via `PATCH {"archived":false}`. Archived contacts must be
restored before editing; an existing archived company association may be retained.

People and companies lives under Settings, and a mail sender links to their Inbox contact panel.
No model, new dependency, background process, outbound send or attachment storage is involved.
