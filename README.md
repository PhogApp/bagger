# Bagger

Sales engagement platform: leads, contacts, accounts, templates, and multi-step outreach sequences (email, LinkedIn, phone) with relative wait days between steps.

## Status

Foundation slice. What exists today:

| Area | Where | Notes |
|---|---|---|
| Data model | `shared/schema.ts`, `migrations/` | Organizations, users, roles, leads, contacts, accounts, templates, sequences, enrollments, step tasks, audit history, event log |
| Sequence engine | `server/sequences/` | Enroll, complete, skip, snooze, pause, resume, stop, remove step, Roll the Calls queue |
| Roles and permissions | `server/auth/permissions.ts` | Admin, Manager, Rep, Read-only presets; per-object scopes and tool switches |
| Audit history | `server/audit/history.ts` | Old value, new value, user, time per changed field |
| Org setup | `server/orgs/provision.ts` | Creates an organization with settings, preset roles, and its first Admin |

| Record API | `server/records/`, `server/http/app.ts` | Leads, contacts, accounts, templates, sequences: permission-checked, org-scoped, audited |
| Sequence API | `server/sequences/service.ts` | Steps, reorder, enroll one person or many at once, pause, stop, the Roll the Calls queue, per-person message edits |
| Duplicates and conversion | `server/records/duplicates.ts`, `server/records/convert.ts` | One definition of "already in Bagger" (people by email across leads and contacts, accounts by name or website), flagged when a record is added or imported; converting a lead to a contact on a chosen account, keeping its sequence and history |
| Statuses | `server/statuses/`, `client/src/components/StatusSettings.tsx` | Each organization's own status lists for leads, contacts, accounts and opportunities (the pipeline stages), set in Admin: add, rename, reorder, color, default, delete with a replacement, and what a status does (ends a sequence, do not contact, won or lost) |
| Pipeline | `server/records/index.ts` (`opportunityService`), `client/src/pages/Opportunities.tsx` | Opportunities on an account with a main contact, amount, expected close date and stage; a board by stage with drag and drop, totals and a weighted total; a list view; a log of every stage move for reports |
| Activities and dashboard | `server/activities/`, `server/dashboard/`, `client/src/pages/Activities.tsx`, `client/src/pages/Dashboard.tsx`, `client/src/components/ActivityTimeline.tsx` | Calls, emails, LinkedIn touches, meetings and notes, each about a lead, contact, account or opportunity. Open (still to do, with a due date and owner; overdue ones flagged) or completed (logged by hand, checked off, or written for each completed step). An Activities page listing them all with search, filters, sorting, columns, paging, bulk changes and export; open ones then completed ones on the Activity tab of every record; the home dashboard for a rep, another rep or everyone |
| Templates and sequences | `client/src/pages/Templates.tsx`, `client/src/pages/SequenceDetail.tsx` | Both lists work like the others (sorting, owner filter, columns, export, bulk owner change and delete). A template has its own page: fields edited in place, a preview with merge fields filled in for a sample person, the sequence steps that use it, and History; it can't be deleted while a step sends it. A sequence has its own page: details edited in place, its steps as a day-by-day timeline edited where they are, the people in it with search and a status filter, and History; it can't be deleted while people are still in it |
| Messages | `client/src/lib/toast.tsx` | One way of saying an action worked or failed, everywhere: a short message in the bottom corner. Successes fade on their own, with Undo where a change can be put back (a field edit, completing an activity, moving an opportunity's stage); warnings (some rows skipped) stay longer; errors stay until closed. Mistakes in a form being filled in are still shown beside the form |
| Rich text email | `client/src/components/RichTextEditor.tsx`, `server/sequences/html.ts`, `shared/richtext.ts` | Email templates, email steps and a rep's edit of one email are formatted: bold, italic, underline, links, bulleted and numbered lists, and a menu to insert merge fields. Saved as a small, cleaned HTML (anything else is removed on the server); merge values are escaped. Roll the Calls shows the formatted email and copies it with formatting for Gmail or Outlook, plus plain text. LinkedIn messages stay plain text, and a sent email is logged on the activity as plain text |
| Click-to-dial | `client/src/components/PhoneLink.tsx`, `shared/phone.ts`, `shared/calls.ts` | Every phone number is a tel: link that hands the number to the rep's phone or softphone (no calling service), shown as (816) 555-1234 and dialed as +18165551234; numbers without a country code are taken as US; an extension is shown but not dialed; anything unreadable stays as typed, without a link; a copy button sits beside it. Completing a Phone Call step in Roll the Calls needs an outcome (Connected, Voicemail, No Answer), stored on the step task and in the step.completed event |
| Full data export | `server/export/service.ts`, `client/src/components/DataExport.tsx` | Admins download everything the organization has as one ZIP: a CSV per kind of record (leads, contacts, accounts, opportunities, activities, templates, sequences, steps, enrollments, step tasks, stage moves, Do Not Contact, statuses, custom fields, saved reports, users, organization) plus all change history and sequence events, with a README. Deleted records included; people named beside their ids; custom fields as labelled columns. Streams as it is built. Works on a locked or cancelled account; each export is logged |
| People leaving and returning | `server/people/`, `client/src/components/PeopleSettings.tsx` | Nobody is deleted. An admin removes someone and picks who takes over; access ends on the last day of the month (or right away), shown as "Ending on <date>" with Undo. When it ends they become inactive (not a paid seat) and their leads, contacts, accounts, opportunities, templates, sequences, saved reports, open activities, running sequences and queue move over, each move in History; completed work keeps their name. Inactive people can be reinstated with their old role. Removing someone in Clerk does the same through a signed webhook (CLERK_WEBHOOK_SECRET), handing records to the owner |
| Billing | `server/billing/`, `client/src/components/BillingPanel.tsx` | $5 per user per month, billed on the 1st for the month ahead, through Stripe (on when STRIPE_SECRET_KEY is set). A card is required before the organization can be used; seats added during a month are prorated by day onto the next 1st; nothing is charged on the day of sign-up; a failed charge locks the account at once (the owner can pay or change the card, admins can export); cancelling lasts to month end; reactivating starts billing again. Bagger works out each bill; Stripe stores the card, charges it and hosts the invoice. The owner's Billing panel shows the card, the next bill line by line, and past bills |
| Search | `server/search/service.ts`, `client/src/components/GlobalSearch.tsx` | The search box at the top of every page: the first five matching leads, contacts, accounts and opportunities with how many match in all, opened with the arrow keys and Enter or a click; "See all" opens the list already searched; "/" jumps to the box. Every word must match, and contacts and opportunities are also found by their account's name |
| Record pages | `client/src/components/RecordDetail.tsx` | Each lead, contact, account and opportunity has its own page (`/accounts/<id>`): fields that save one at a time as you change them (Escape cancels, Undo after each save, a question before a status that ends a sequence), related records, and Activity and History tabs |
| Custom fields and layout | `server/fields/service.ts`, `client/src/lib/fields.tsx`, `client/src/components/FieldSettings.tsx` | Admin-defined fields on leads, contacts, accounts and opportunities (12 types, required, picklist choices that rename and replace on records, archive); the order, width and visibility of every field on record pages; custom fields in forms, record pages, History, CSV import, conversion and `{custom.key}` / `{account.key}` merge fields |
| Reports | `server/reports/standard.ts`, `client/src/pages/Reports.tsx` | Standard reports for a date range and a rep: sequence and step performance, activity by rep and over time, pipeline (open by stage, win rate, average deal, time to win, time in stage) and lead conversion, each downloadable as CSV |
| Report builder | `server/reports/builder.ts`, `client/src/pages/ReportBuilder.tsx` | Custom reports on leads, contacts, accounts, opportunities and activities: columns (custom fields included), filters by field type with relative dates, up to two groupings, count / sum / average / min / max, table or bar chart, saved privately or shared, CSV of every row for roles allowed to export |
| CSV import | `server/records/import.ts`, `client/src/components/ImportRecords.tsx` | Leads, contacts and accounts from a CSV file: sample file download, column matching in the browser, a check for records already in Bagger (people by email, accounts by name or website) before anything is saved, then skip or overwrite them; bad rows reported by line |

| Sign-in | `server/auth/clerk.ts`, `server/auth/identity.ts` | Clerk session to Bagger user, organization and role; first sign-in creates them |
| Server | `server/index.ts`, `server/db/` | Production entry point, database connection, migrations |
| Web client | `client/` | Sign-in, organization picker, app layout, and screens for Leads, Contacts, Accounts, Templates, Sequences (steps, people, enrolling), Roll the Calls, personal Settings, Admin (wait-day rule, users and roles) and the owner's Organization page |
| Hosting | `render.yaml` | Render Blueprint for the staging web service and database |

Not built yet, and billing. Messages are plain text; rich text is not yet supported.

## Sequence rules

- An enrollment has one open task at a time. Later steps are not created ahead of time.
- Wait days count from when the previous step was completed, not from when it was due.
- Business days or calendar days is an organization setting, chosen by an admin.
- Due dates follow the task owner's own time zone (their setting, else the organization default).
- A linked template drives a step's content; a rep can edit the message for one person before sending.
- Editing a sequence never rebuilds tasks. Each enrollment reads the current step order when it next advances.
- A person can be in one sequence at a time.

## Development

Requires Node 20 or later.

```
npm install
npm run check        # type-check
npm test             # run the test suite (uses an in-process Postgres; no database needed)
npm run db:generate  # create a migration after changing shared/schema.ts
npm run build        # build the web client and server into dist/
```

To run locally, copy `.env.example` to `.env`, fill it in, then `npm run build && npm run db:migrate && npm start`. The server refuses to start without its Clerk keys, so it can never run with sign-in switched off.

To look at the screens without Clerk or a database, run `npm run preview` and open http://localhost:4000. It uses an in-memory database with sample data; set `PREVIEW_AS=rep` to see them as a Rep. The preview server lives in `tests/` and is not part of the deployed build.

## Hosting

`render.yaml` describes the staging environment on Render. Merging to `main` deploys automatically once the tests pass; migrations run before the new version takes traffic. The Clerk keys are entered in the Render dashboard and are never stored in this repository.
