import path from "node:path";
import { clerkAuthenticator, clerkRoleSync, clerkSession } from "./auth/clerk";
import { connect } from "./db/client";
import { createApp } from "./http/app";
import { finalizeAllDue } from "./people/service";

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
const app = createApp(db, clerkAuthenticator(db), {
  before: [clerkSession()],
  publicConfig: { clerkPublishableKey },
  onRoleChange: clerkRoleSync(db),
  staticDir: path.resolve("dist/public"),
  // Optional until the webhook is set up in Clerk; removals made in Admin work without it.
  clerkWebhookSecret: process.env.CLERK_WEBHOOK_SECRET || undefined,
});

// Seats end on their last day even if nobody from that organization signs in.
const endSeats = () =>
  finalizeAllDue(db)
    .then((n) => n > 0 && console.log(`Ended ${n} seat(s) whose last day had passed`))
    .catch((e: unknown) => console.error("Ending seats failed", e));
void endSeats();
const seatTimer = setInterval(endSeats, 60 * 60 * 1000);

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Bagger listening on port ${port}`);
});

function shutdown() {
  clearInterval(seatTimer);
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
