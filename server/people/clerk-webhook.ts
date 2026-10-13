import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Clerk sends its webhooks through Svix, which signs each one. A request is
 * accepted only when its signature matches the endpoint's signing secret
 * (CLERK_WEBHOOK_SECRET, entered in Render) and it is less than five minutes
 * old, so nobody else can remove people by calling the endpoint.
 */

const TOLERANCE_SECONDS = 5 * 60;

export interface WebhookHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

export function verifyClerkWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: Buffer | string,
  now: number = Date.now(),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const sent = Number(timestamp);
  if (!Number.isFinite(sent) || Math.abs(now / 1000 - sent) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body.toString()}`)
    .digest();
  // The header can carry several signatures ("v1,abc v1,def") during key rotation.
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Sign a body the way Clerk does; for tests. */
export function signClerkWebhook(secret: string, id: string, timestamp: string, body: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/** The parts of Clerk's events Bagger acts on. */
export interface ClerkEvent {
  type: string;
  data: {
    id?: string;
    organization?: { id?: string };
    public_user_data?: { user_id?: string };
  };
}
