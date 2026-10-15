import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where a change came from, when it isn't a person using Bagger's screens.
 *
 * - A sync runs inside `asIntegration`: history says "via HubSpot" and carries
 *   the connection, so the change feed knows not to send it back to HubSpot.
 * - A public API request runs inside `asApi`: history says "via API: <key name>".
 */
export interface ChangeOrigin {
  source: "integration" | "api";
  via: string;
  connectionId: string | null;
}

const origin = new AsyncLocalStorage<ChangeOrigin>();

export function asIntegration<T>(
  from: { via: string; connectionId: string },
  work: () => Promise<T>,
): Promise<T> {
  return origin.run({ source: "integration", ...from }, work);
}

export function asApi<T>(keyName: string, work: () => Promise<T>): Promise<T> {
  return origin.run({ source: "api", via: `API: ${keyName}`, connectionId: null }, work);
}

export function currentOrigin(): ChangeOrigin | undefined {
  return origin.getStore();
}
