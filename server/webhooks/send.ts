import { lookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * Sending a webhook safely. A customer chooses the URL, so Bagger must never
 * be talked into calling its own private network (cloud metadata, internal
 * services): addresses are checked when the URL is saved and again, after DNS,
 * at the moment of sending. Only https, no redirects followed, 10 seconds.
 */

function v4Private(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Loopback, private, link-local, multicast or otherwise not the public internet. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return true;
  const x = ip.toLowerCase();
  const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  return (
    x === "::" ||
    x === "::1" ||
    x.startsWith("fc") ||
    x.startsWith("fd") ||
    /^fe[89ab]/.test(x) ||
    x.startsWith("ff") ||
    x.startsWith("64:ff9b:") ||
    x.startsWith("2001:db8")
  );
}

export class UnsafeUrlError extends Error {}

/** A URL a webhook may be sent to. Throws UnsafeUrlError with a reason a person can act on. */
export function checkWebhookUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new UnsafeUrlError("Enter a full web address, starting https://");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new UnsafeUrlError("Webhook addresses must start https://");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Put credentials in the receiving system, not in the address");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !allowPrivate &&
    (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateAddress(host)))
  ) {
    throw new UnsafeUrlError("Webhook addresses must be on the public internet");
  }
  return url;
}

/** DNS that refuses to hand over private addresses, so a public name can't point inside. */
function guardedLookup(allowPrivate: boolean) {
  return ((hostname: string, options: object, callback: (...args: unknown[]) => void) => {
    lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err);
      const ok = allowPrivate ? addresses : addresses.filter((a) => !isPrivateAddress(a.address));
      if (ok.length === 0) {
        return callback(new UnsafeUrlError(`${hostname} isn't on the public internet`));
      }
      if ((options as { all?: boolean }).all) return callback(null, ok);
      callback(null, ok[0].address, ok[0].family);
    });
  }) as unknown as typeof lookup;
}

export interface SendResult {
  status: number;
  /** The start of their answer, for the delivery log. */
  body: string;
}

export function postJson(
  url: URL,
  body: string,
  headers: Record<string, string>,
  options: { allowPrivate: boolean; timeoutMs?: number },
): Promise<SendResult> {
  checkWebhookUrl(url.toString(), options.allowPrivate);
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        lookup: guardedLookup(options.allowPrivate),
        timeout: options.timeoutMs ?? 10_000,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < 1000) text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text.slice(0, 1000) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("No answer within 10 seconds")));
    req.on("error", reject);
    req.end(body);
  });
}
