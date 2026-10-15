/**
 * What Bagger needs from each outside service it syncs with. Each service
 * (HubSpot, Salesforce, …) is one Provider; the sync engine
 * (server/integrations/sync.ts) does the rest the same way for all of them:
 * linking records, matching, creating, sending changes back, the sync log.
 */

/** The kinds of Bagger record a sync can carry so far. */
export type SyncRecordType = "account" | "contact";

export interface ObjectMapping {
  recordType: SyncRecordType;
  /** The service's name for it, e.g. "companies". */
  external: string;
  /** How Settings shows it, e.g. "Companies ↔ Accounts". */
  label: string;
  /** Bagger field → the service's field. */
  fields: Record<string, string>;
  /** Contacts: the service's field holding the contact's company id. */
  accountField?: string;
}

export interface Credentials {
  accessToken: string;
  refreshToken?: string | null;
  /** Milliseconds since 1970. */
  expiresAt?: number | null;
  [extra: string]: unknown;
}

export interface ConnectedAccount {
  externalAccountId: string;
  /** Who we're connected as, shown to the admin. */
  label: string;
  credentials: Credentials;
}

export interface ExternalRecord {
  id: string;
  /** ISO time the service last changed it. */
  updatedAt: string;
  fields: Record<string, string | null>;
}

/** The service no longer accepts our credentials: an admin must connect again. */
export class ReconnectNeeded extends Error {}

/** The service asked us to slow down. */
export class RateLimited extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Rate limited; try again in ${retryAfterSeconds}s`);
  }
}

export interface Provider {
  id: string;
  name: string;
  objects: ObjectMapping[];
  /** The service's sign-in page, which sends the admin back to `redirectUri`. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Turn the code from that page into credentials. */
  connect(code: string, redirectUri: string): Promise<ConnectedAccount>;
  /** New credentials when the access token has expired. */
  refresh?(credentials: Credentials): Promise<Credentials>;
  /** Records changed since `since` (ISO), a page at a time. */
  list(
    credentials: Credentials,
    external: string,
    page: { since: string | null; cursor: string | null },
  ): Promise<{ records: ExternalRecord[]; next: string | null }>;
  create(
    credentials: Credentials,
    external: string,
    fields: Record<string, string | null>,
  ): Promise<ExternalRecord>;
  update(
    credentials: Credentials,
    external: string,
    id: string,
    fields: Record<string, string | null>,
  ): Promise<ExternalRecord>;
}

/** Every service on the roadmap, shown in Admin whether or not it's ready yet. */
export interface CatalogEntry {
  id: string;
  name: string;
  category: "CRM" | "Data" | "Email and calendar";
  description: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "hubspot",
    name: "HubSpot",
    category: "CRM",
    description:
      "Keep contacts and companies in step both ways, and log Bagger's calls and emails.",
  },
  {
    id: "salesforce",
    name: "Salesforce",
    category: "CRM",
    description: "Sync contacts, accounts and opportunities, and log activity back.",
  },
  {
    id: "zoominfo",
    name: "ZoomInfo",
    category: "Data",
    description: "Bring in contacts and companies, and fill in phones, titles and company details.",
  },
  {
    id: "google",
    name: "Gmail and Google Calendar",
    category: "Email and calendar",
    description: "Send sequence emails from each rep's own mailbox and log meetings.",
  },
  {
    id: "microsoft",
    name: "Outlook and Microsoft 365",
    category: "Email and calendar",
    description: "Send sequence emails from Outlook and log meetings from the calendar.",
  },
];
