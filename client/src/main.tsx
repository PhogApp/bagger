import {
  ClerkProvider,
  OrganizationList,
  OrganizationSwitcher,
  SignedIn,
  SignedOut,
  SignIn,
  useAuth,
  useClerk,
  useOrganization,
  useUser,
} from "@clerk/clerk-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Brand } from "./components/Brand";
import { SessionProvider, type Session } from "./lib/session";
import "./styles.css";

interface Config {
  clerkPublishableKey?: string;
  /** Only ever sent by the local preview server. */
  devUser?: string;
  devOrg?: string;
  devOrgName?: string;
  devUserName?: string;
}

/** Makes Clerk's sign-in and account screens match Bagger's palette and type. */
const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: "#377890", // Ocean Blue: buttons and links
    colorText: "#284B5E", // Deep Aerospace Blue
    colorDanger: "#b4443f",
    borderRadius: "0.5rem",
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  },
};

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted p-4">
      {children}
    </div>
  );
}

function WithQueries({ scope, children }: { scope: string; children: ReactNode }) {
  // A fresh cache per organization, so switching never shows another org's data.
  const client = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 10_000 } } }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope],
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function ClerkSession() {
  const { getToken } = useAuth();
  const clerk = useClerk();
  const { user } = useUser();
  const { organization, isLoaded } = useOrganization();
  const authHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }, [getToken]);

  if (!isLoaded) return <Centered>Loading…</Centered>;
  // Everything in Bagger belongs to an organization, so pick or create one first.
  if (!organization) {
    return (
      <Centered>
        <Brand large />
        <OrganizationList
          hidePersonal
          hideSlug
          afterCreateOrganizationUrl="/"
          afterSelectOrganizationUrl="/"
        />
      </Centered>
    );
  }
  const session: Session = {
    authHeaders,
    orgName: organization.name,
    userName: user?.fullName || user?.primaryEmailAddress?.emailAddress || "You",
    userImageUrl: user?.hasImage ? user.imageUrl : undefined,
    manageAccount: () => clerk.openUserProfile(),
    signOut: () => void clerk.signOut(),
    manageMembers: () => clerk.openOrganizationProfile(),
    orgSwitcher: (
      <OrganizationSwitcher
        hidePersonal
        hideSlug
        afterSelectOrganizationUrl="/"
        appearance={{
          elements: {
            // A signed-in user already has an organization. Starting another
            // one from here would create a separate, separately billed customer.
            organizationSwitcherPopoverActionButton__createOrganization: { display: "none" },
          },
        }}
      />
    ),
  };
  return (
    <SessionProvider value={session}>
      <WithQueries scope={organization.id}>
        <App />
      </WithQueries>
    </SessionProvider>
  );
}

function PreviewSession({ config }: { config: Config }) {
  const session: Session = {
    authHeaders: async () => ({ "x-user": config.devUser!, "x-org": config.devOrg! }),
    orgName: config.devOrgName ?? "Preview",
    userName: config.devUserName ?? "Preview User",
  };
  return (
    <SessionProvider value={session}>
      <WithQueries scope="preview">
        <App />
      </WithQueries>
    </SessionProvider>
  );
}

function Root() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((c: Config) => {
        if (c.clerkPublishableKey || c.devUser) setConfig(c);
        else setError("Sign-in is not configured on this server.");
      })
      .catch(() => setError("Could not reach the server."));
  }, []);

  if (error) return <Centered><p className="text-destructive">{error}</p></Centered>;
  if (!config) return <Centered>Loading…</Centered>;
  if (config.devUser) return <PreviewSession config={config} />;
  return (
    <ClerkProvider
      publishableKey={config.clerkPublishableKey!}
      afterSignOutUrl="/"
      appearance={CLERK_APPEARANCE}
    >
      <SignedOut>
        <Centered>
          <Brand large />
          <SignIn routing="hash" />
        </Centered>
      </SignedOut>
      <SignedIn>
        <ClerkSession />
      </SignedIn>
    </ClerkProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
