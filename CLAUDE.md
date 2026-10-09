# Bagger: notes for Claude

- Product decisions live in the claude.ai Project "Bagger": `bagger-build-spec.md` and `bagger-pricing-and-billing.md`. Read them before changing behavior.
- Every tenant table has `org_id`. Every service function takes `ctx: { orgId, userId }` and must filter by `ctx.orgId`.
- State changes go through service functions inside one `db.transaction`. Audit history (`server/audit/history.ts`) is written in the same transaction as the change.
- The sequence engine (`server/sequences/engine.ts`) is the only code that creates or closes step tasks. Do not write to `step_tasks` or `enrollments` from anywhere else.
- Dates for due tasks are calendar dates (`YYYY-MM-DD`) in the organization's time zone, never timestamps.
- Records are soft-deleted (`deleted_at`).
- After changing `shared/schema.ts`, run `npm run db:generate` and commit the migration.
- Before committing: `npm run check && npm test`. Tests run against PGlite with the real migrations and take about a minute.
