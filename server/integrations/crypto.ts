import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Keeping outside services' credentials secret. Tokens are sealed with
 * AES-256-GCM under INTEGRATIONS_KEY (a long random secret, set in Render
 * only) before they touch the database, so a copy of the database alone
 * doesn't open anyone's HubSpot. The same key signs the round trip to a
 * service's sign-in page, so a connection can only land in the organization
 * and for the admin that started it.
 */

export class IntegrationKey {
  private constructor(private readonly key: Buffer) {}

  /**
   * From INTEGRATIONS_KEY: 32 bytes in base64, or any random secret of at
   * least 32 characters (a key is derived from it). Throws on anything shorter.
   */
  static fromSecret(value: string): IntegrationKey {
    const secret = value.trim();
    const raw = Buffer.from(secret, "base64");
    if (raw.length === 32 && /^[A-Za-z0-9+/]+=*$/.test(secret)) return new IntegrationKey(raw);
    if (secret.length < 32) {
      throw new Error("INTEGRATIONS_KEY must be a random secret of at least 32 characters");
    }
    return new IntegrationKey(
      Buffer.from(hkdfSync("sha256", secret, "bagger", "integrations-key", 32)),
    );
  }

  static generate(): IntegrationKey {
    return new IntegrationKey(randomBytes(32));
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return [
      "v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      body.toString("base64"),
    ].join(":");
  }

  open<T>(sealed: string): T {
    const [version, iv, tag, body] = sealed.split(":");
    if (version !== "v1" || !iv || !tag || !body) throw new Error("Unreadable credentials");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const text = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]);
    return JSON.parse(text.toString("utf8")) as T;
  }

  private mac(text: string): string {
    return createHmac("sha256", this.key).update(`state:${text}`).digest("base64url");
  }

  /** A tamper-proof note that survives the trip to a sign-in page and back. */
  signState(payload: Record<string, unknown>): string {
    const text = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${text}.${this.mac(text)}`;
  }

  readState<T>(state: string): T | null {
    const [text, mac] = state.split(".");
    if (!text || !mac) return null;
    const want = Buffer.from(this.mac(text));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      return JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as T;
    } catch {
      return null;
    }
  }
}
