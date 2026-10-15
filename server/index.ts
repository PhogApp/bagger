import path from "node:path";
import {
  clerkAuthenticator,
  clerkRoleSync,
  clerkSession,
  deleteClerkOrganization,
} from "./auth/clerk";
import { connect } from "./db/client";
import { createApp } from "./http/app";
import { finalizeAllDue } from "./people/service";
import { StripeGateway } from "./billing/gateway";
import { runBillingCycle } from "./billing/service";
import { parseStaffEmails } from "./staff/service";
import { IntegrationKey } from "./integrations/crypto";
import { pruneFeed } from "./integrations/feed";
import { integrationJobs, scheduleSyncs } from "./integrations/jobs";
import type { IntegrationsConfig } from "./integrations/sync";
import { pruneJobs, runDueJobs } from "./jobs/queue";
import { pruneIdempotency } from "./api/v1";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Refuse to start half-configured. In particular, never run without sign-in.
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const databaseUrl = required("DATABASE_URL");
required("CLERK_SECRET_KEY");
const clerkPublishableKey = required("CLERK_PUBLISHABLE_KEY");

const { db, pool } = connect(databaseUrl);

// Payments switch on when Stripe's secret key is set (test-mode keys on staging).
const stripeKey = process.env.STRIPE_SECRET_KEY;
const billingGateway = stripeKey
  ? new StripeGateway(stripeKey, process.env.STRIPE_WEBHOOK_SECRET || undefined)
  : null;
if (stripeKey && !process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn("STRIPE_WEBHOOK_SECRET is not set: Stripe's later payment updates won't arrive");
}
// Integrations switch on with INTEGRATIONS_KEY, which seals each service's credentials.
// Services are added here as they're built (HubSpot first).
const integrationsKey = process.env.INTEGRATIONS_KEY
  ? IntegrationKey.fromSecret(process.env.INTEGRATIONS_KEY)
  : null;
const integrations: IntegrationsConfig = { key: integrationsKey, providers: {} };
const jobHandlers = { ...integrationJobs(integrations) };

const app = createApp(db, clerkAuthenticator(db), {
  before: [clerkSession()],
  publicConfig: { clerkPublishableKey },
  onRoleChange: clerkRoleSync(db),
  staticDir: path.resolve("dist/public"),
  // Optional until the webhook is set up in Clerk; removals made in Admin work without it.
  clerkWebhookSecret: process.env.CLERK_WEBHOOK_SECRET || undefined,
  billing: billingGateway,
  // Bagger staff, by email, who can open the staff console. Set in Render only.
  staffEmails: parseStaffEmails(process.env.STAFF_EMAILS),
  onOrgDeleted: deleteClerkOrganization,
  integrations,
});

// Seats end on their last day even if nobody from that organization signs in.
// Bills go out on the 1st; running hourly means a restart never misses one.
const endSeats = async () => {
  try {
    const n = await finalizeAllDue(db);
    if (n > 0) console.log(`Ended ${n} seat(s) whose last day had passed`);
    if (billingGateway) {
      const run = await runBillingCycle(db, billingGateway);
      if (run.billed + run.failed + run.cancelled > 0) console.log("Billing run", run);
    }
  } catch (e) {
    console.error("Hourly seats and billing run failed", e);
  }
};
void endSeats();
const seatTimer = setInterval(endSeats, 60 * 60 * 1000);

// Background jobs (syncs now, more later) run every few seconds; syncs are queued
// every few minutes for connections that are due; old jobs and changes are pruned hourly.
let working = false;
const work = async () => {
  if (working) return;
  working = true;
  try {
    while ((await runDueJobs(db, jobHandlers)).ran > 0) {
      // keep going while there's work
    }
  } catch (e) {
    console.error("Background jobs failed", e);
  } finally {
    working = false;
  }
};
const jobTimer = setInterval(work, 5000);
const scheduleTimer = setInterval(
  () => void scheduleSyncs(db).catch((e) => console.error("Scheduling syncs failed", e)),
  5 * 60 * 1000,
);
const pruneTimer = setInterval(
  () =>
    void Promise.all([pruneJobs(db), pruneFeed(db), pruneIdempotency(db)]).catch((e) =>
      console.error("Pruning failed", e),
    ),
  60 * 60 * 1000,
);

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Bagger listening on port ${port}`);
});

function shutdown() {
  clearInterval(seatTimer);
  clearInterval(jobTimer);
  clearInterval(scheduleTimer);
  clearInterval(pruneTimer);
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
