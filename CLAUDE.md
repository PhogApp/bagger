# Bagger: notes for Claude

- Product decisions live in the claude.ai Project "Bagger": `bagger-build-spec.md` and `bagger-pricing-and-billing.md`. Read them before changing behavior.
- Every tenant table has `org_id`. Every service function takes `ctx: { orgId, userId }` and must filter by `ctx.orgId`.
- State changes go through service functions inside one `db.transaction`. Audit history (`server/audit/history.ts`) is written in the same transaction as the change.
- The sequence engine (`server/sequences/engine.ts`) is the only code that creates or closes step tasks. Do not write to `step_tasks` or `enrollments` from anywhere else.
- Dates for due tasks are calendar dates (`YYYY-MM-DD`) in the task owner's time zone (their own setting, else the organization default), never timestamps.
- Records are soft-deleted (`deleted_at`).
- After changing `shared/schema.ts`, run `npm run db:generate` and commit the migration.
- Before committing: `npm run check && npm test`. Tests run against PGlite with the real migrations and take about a minute.
- Three levels of access below the record permissions: everyone has Settings; Admins (role) have Admin; exactly one owner per organization (`organizations.owner_user_id`, `actor.isOwner`) has Organization. The owner is always an Admin. Billing belongs to the owner.
- Statuses are per organization (`status_options`, `server/statuses/service.ts`). Records store the status name. Never compare a status to a fixed word such as "Do Not Contact"; look up the option's `effect`. New organizations are seeded from `server/statuses/defaults.ts`.
- Custom field values live in each record's `custom` jsonb, keyed by the field's fixed `key`. Check and merge them with `settleCustom` (`server/fields/service.ts`); in the client a custom field is named `custom.<key>` and `toBody` gathers them for the API.
- The staff console (`server/staff/`) is the only code that reads across organizations. Staff are the emails in `STAFF_EMAILS`; their actions go in `staff_actions`, never a customer's history except as a system change.
- Every history row also feeds `change_feed` (a database trigger), which integrations and webhooks read. Don't write record changes without history, or they won't sync.
- Work done for an outside service runs inside `asIntegration` (`server/audit/origin.ts`) so its history says "via <service>" and the change isn't sent back. Background work goes through the job queue (`server/jobs/queue.ts`), not timers.
