import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where a change came from, when it isn't a person using Bagger. A sync runs
 * its work inside `asIntegration`, and every history row written meanwhile
 * says "via HubSpot" and carries the connection, so the change feed knows not
 * to send that change back to HubSpot.
 */
export interface ChangeOrigin {
  via: string;
  connectionId: string;
}

const origin = new AsyncLocalStorage<ChangeOrigin>();

export function asIntegration<T>(from: ChangeOrigin, work: () => Promise<T>): Promise<T> {
  return origin.run(from, work);
}

export function currentOrigin(): ChangeOrigin | undefined {
  return origin.getStore();
}
