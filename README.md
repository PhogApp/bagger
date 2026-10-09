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
| Sequence API | `server/sequences/service.ts` | Steps, reorder, enroll, pause, stop, the Run Steps queue, per-person message edits |

Not built yet: sign-in (Clerk), the production server entry point, hosting, and screens. The API takes an `Authenticator` function; tests supply a stand-in.

## Sequence rules

- An enrollment has one open task at a time. Later steps are not created ahead of time.
- Wait days count from when the previous step was completed, not from when it was due.
- Business days or calendar days is an organization setting.
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
```
