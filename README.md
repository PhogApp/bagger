# Bagger

Sales engagement platform: leads, contacts, accounts, templates, and multi-step outreach sequences (email, LinkedIn, phone) with relative wait days between steps.

## Status

Foundation slice. What exists today:

| Area | Where | Notes |
|---|---|---|
| Data model | `shared/schema.ts`, `migrations/` | Organizations, users, roles, leads, contacts, accounts, templates, sequences, enrollments, step tasks, audit history, event log |
| Sequence engine | `server/sequences/` | Enroll, complete, skip, snooze, pause, resume, stop, remove step, Run Steps queue |
| Roles and permissions | `server/auth/permissions.ts` | Admin, Manager, Rep, Read-only presets; per-object scopes and tool switches |
| Audit history | `server/audit/history.ts` | Old value, new value, user, time per changed field |
| Org setup | `server/orgs/provision.ts` | Creates an organization with settings, preset roles, and its first Admin |

| Record API | `server/records/`, `server/http/app.ts` | Leads, contacts, accounts, templates, sequences: permission-checked, org-scoped, audited |
| Sequence API | `server/sequences/service.ts` | Steps, reorder, enroll one person or many at once, pause, stop, the Run Steps queue, per-person message edits |
| CSV import | `server/records/import.ts`, `client/src/components/ImportLeads.tsx` | Leads from a CSV file: column matching in the browser, duplicates by email skipped, bad rows reported by line |

| Sign-in | `server/auth/clerk.ts`, `server/auth/identity.ts` | Clerk session to Bagger user, organization and role; first sign-in creates them |
| Server | `server/index.ts`, `server/db/` | Production entry point, database connection, migrations |
| Web client | `client/` | Sign-in, organization picker, app layout, and screens for Leads, Contacts, Accounts, Templates, Sequences (steps, people, enrolling), Run Steps, personal Settings, Admin (wait-day rule, users and roles) and the owner's Organization page |
| Hosting | `render.yaml` | Render Blueprint for the staging web service and database |

Not built yet: a dashboard, lead conversion, the opportunity pipeline, reporting, and billing. Messages are plain text; rich text is not yet supported.

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
