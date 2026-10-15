import {
  ReconnectNeeded,
  type Credentials,
  type ExternalRecord,
  type ObjectMapping,
  type Provider,
} from "./providers";

/**
 * A stand-in CRM that lives in memory, for tests and the local preview. It
 * behaves like a real one where it matters (its own ids, change times,
 * paging, expiring tokens) so the sync engine can be proven before HubSpot.
 */
export class DemoCrm implements Provider {
  id = "demo";
  name = "Demo CRM";
  objects: ObjectMapping[] = [
    {
      recordType: "account",
      external: "companies",
      label: "Companies ↔ Accounts",
      fields: { name: "name", website: "domain", hqPhone: "phone" },
    },
    {
      recordType: "contact",
      external: "contacts",
      label: "Contacts ↔ Contacts",
      fields: {
        firstName: "firstname",
        lastName: "lastname",
        email: "email",
        title: "jobtitle",
        directPhone: "phone",
      },
      accountField: "companyId",
    },
  ];

  store: Record<string, Map<string, ExternalRecord>> = {
    companies: new Map(),
    contacts: new Map(),
  };
  private seq = 0;
  private clock = Date.parse("2026-01-01T00:00:00Z");
  /** Make the next calls fail as if the admin revoked access. */
  revoked = false;
  pageSize = 2;
  calls = { create: 0, update: 0, list: 0, refresh: 0 };

  private tick() {
    this.clock = Math.max(this.clock + 1, Date.now());
    return new Date(this.clock).toISOString();
  }

  /** Add or change a record as if someone did it in the CRM. */
  put(external: string, fields: Record<string, string | null>, id?: string): ExternalRecord {
    const key = id ?? `${external === "companies" ? "co" : "ct"}_${++this.seq}`;
    const before = this.store[external].get(key);
    const record = {
      id: key,
      updatedAt: this.tick(),
      fields: { ...(before?.fields ?? {}), ...fields },
    };
    this.store[external].set(key, record);
    return record;
  }

  find(external: string, field: string, value: string) {
    return [...this.store[external].values()].find((r) => r.fields[field] === value);
  }

  authorizeUrl(state: string, redirectUri: string) {
    return `${redirectUri}?code=demo-code&state=${encodeURIComponent(state)}`;
  }

  async connect(code: string) {
    if (code !== "demo-code") throw new ReconnectNeeded("That sign-in didn't work");
    return {
      externalAccountId: "demo-account",
      label: "Demo CRM sandbox",
      credentials: { accessToken: "demo-token-1", refreshToken: "demo-refresh", expiresAt: 0 },
    };
  }

  async refresh(credentials: Credentials) {
    this.calls.refresh += 1;
    if (this.revoked) throw new ReconnectNeeded("Access was revoked in Demo CRM");
    return {
      ...credentials,
      accessToken: `demo-token-${this.calls.refresh + 1}`,
      expiresAt: Date.now() + 3_600_000,
    };
  }

  private check(credentials: Credentials) {
    if (this.revoked || !credentials.accessToken.startsWith("demo-token")) {
      throw new ReconnectNeeded("Access was revoked in Demo CRM");
    }
  }

  async list(
    credentials: Credentials,
    external: string,
    page: { since: string | null; cursor: string | null },
  ) {
    this.check(credentials);
    this.calls.list += 1;
    const all = [...this.store[external].values()]
      .filter((r) => !page.since || r.updatedAt > page.since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const start = page.cursor ? Number(page.cursor) : 0;
    const records = all.slice(start, start + this.pageSize);
    return {
      records,
      next: start + this.pageSize < all.length ? String(start + this.pageSize) : null,
    };
  }

  async create(credentials: Credentials, external: string, fields: Record<string, string | null>) {
    this.check(credentials);
    this.calls.create += 1;
    return this.put(external, fields);
  }

  async update(
    credentials: Credentials,
    external: string,
    id: string,
    fields: Record<string, string | null>,
  ) {
    this.check(credentials);
    this.calls.update += 1;
    if (!this.store[external].has(id)) throw new Error(`No ${external} record ${id}`);
    return this.put(external, fields, id);
  }
}
