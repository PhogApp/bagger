import { ClerkProvider } from "@clerk/clerk-react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

/** The sign-in key is not secret, but it differs per environment, so the server supplies it. */
function Root() {
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((config: { clerkPublishableKey?: string }) => {
        if (config.clerkPublishableKey) setKey(config.clerkPublishableKey);
        else setError("Sign-in is not configured on this server.");
      })
      .catch(() => setError("Could not reach the server."));
  }, []);

  if (error) return <div className="center error">{error}</div>;
  if (!key) return <div className="center">Loading…</div>;
  return (
    <ClerkProvider publishableKey={key} afterSignOutUrl="/">
      <App />
    </ClerkProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
