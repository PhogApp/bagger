import {
  OrganizationList,
  OrganizationSwitcher,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth,
  useOrganization,
  UserButton,
} from "@clerk/clerk-react";
import { useEffect, useState } from "react";

interface Me {
  user: { name: string; email: string };
  role: string;
  billingStatus: string;
}

function Brand() {
  return (
    <div className="brand">
      <span>●</span> Bagger
    </div>
  );
}

/** Calls the Bagger API as the signed-in user. */
function useApi() {
  const { getToken } = useAuth();
  return async function api<T>(path: string): Promise<T> {
    const token = await getToken();
    const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`${path} answered ${res.status}`);
    return (await res.json()) as T;
  };
}

function Home({ orgName }: { orgName: string }) {
  const api = useApi();
  const [me, setMe] = useState<Me | null>(null);
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const who = await api<Me>("/api/me");
        if (cancelled) return;
        setMe(who);
        if (who.billingStatus === "active") {
          const leads = await api<unknown[]>("/api/leads");
          if (!cancelled) setLeadCount(leads.length);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Something went wrong");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgName]);

  if (error) return <div className="card error">{error}</div>;
  if (!me) return <div className="card">Loading…</div>;
  return (
    <>
      <div className="card">
        <h2>You're signed in</h2>
        <p>Sign-in, your organization, and the database are connected.</p>
        <dl>
          <dt>Name</dt>
          <dd>{me.user.name}</dd>
          <dt>Email</dt>
          <dd>{me.user.email}</dd>
          <dt>Organization</dt>
          <dd>{orgName}</dd>
          <dt>Role</dt>
          <dd>
            <span className="badge">{me.role}</span>
          </dd>
          <dt>Leads</dt>
          <dd>{leadCount ?? "—"}</dd>
        </dl>
      </div>
      <div className="card">
        <h2>What's next</h2>
        <p>Leads, contacts, accounts, templates, sequences and Run Steps screens arrive next.</p>
      </div>
    </>
  );
}

function SignedInApp() {
  const { organization, isLoaded } = useOrganization();
  if (!isLoaded) return <div className="center">Loading…</div>;

  // Everything in Bagger belongs to an organization, so pick or create one first.
  if (!organization) {
    return (
      <div className="center">
        <Brand />
        <OrganizationList
          hidePersonal
          afterCreateOrganizationUrl="/"
          afterSelectOrganizationUrl="/"
        />
      </div>
    );
  }

  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="right">
          <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/" />
          <UserButton />
        </div>
      </header>
      <main>
        <Home key={organization.id} orgName={organization.name} />
      </main>
    </>
  );
}

export function App() {
  return (
    <>
      <SignedOut>
        <div className="center">
          <Brand />
          <SignIn routing="hash" />
        </div>
      </SignedOut>
      <SignedIn>
        <SignedInApp />
      </SignedIn>
    </>
  );
}
