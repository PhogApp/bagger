import path from "node:path";
import { clerkAuthenticator, clerkRoleSync, clerkSession } from "./auth/clerk";
import { connect } from "./db/client";
import { createApp } from "./http/app";

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
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Bagger listening on port ${port}`);
});

function shutdown() {
  server.close(() => {
    void pool.end().then(() => process.exit(0));
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
