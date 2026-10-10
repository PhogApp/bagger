import { createContext, useContext, type ReactNode } from "react";

/**
 * How the browser proves who it is to the Bagger API. In production this is
 * a Clerk session token. The local preview server (tests/dev-server.ts) uses
 * plain headers instead; the production server ignores those headers.
 */
export interface Session {
  authHeaders: () => Promise<Record<string, string>>;
  orgName: string;
  userName: string;
  /** The user's photo, when they have uploaded one. */
  userImageUrl?: string;
  /** Opens the screen for name, email, password and sign-in methods. */
  manageAccount?: () => void;
  signOut?: () => void;
  /** Opens the screen for inviting and removing people. */
  manageMembers?: () => void;
  /** Lets someone who belongs to several organizations move between them. */
  orgSwitcher?: ReactNode;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession used outside SessionProvider");
  return session;
}
