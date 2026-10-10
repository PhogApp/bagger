import { Redirect, Route, Switch } from "wouter";
import { AppLayout } from "./components/AppLayout";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useApi, useMe } from "./lib/api";
import { AccountsPage } from "./pages/Accounts";
import { ContactsPage } from "./pages/Contacts";
import { LeadsPage } from "./pages/Leads";
import { SequenceDetailPage } from "./pages/SequenceDetail";
import { SequencesPage } from "./pages/Sequences";
import { AdminPage, browserTimeZone, SettingsPage } from "./pages/Settings";
import { TemplatesPage } from "./pages/Templates";

function Notice({ title, children }: { title: string; children: string }) {
  return (
    <div className="p-10 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * The first time someone uses Bagger, remember their browser's time zone so
 * due dates are right without any setup. They can change it under Settings.
 */
function useFirstVisitTimeZone(ready: boolean) {
  const api = useApi();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      const mine = await api<{ timezone: string | null }>("GET", "/api/me/settings");
      if (cancelled || mine.timezone) return;
      await api("PATCH", "/api/me/settings", { timezone: browserTimeZone() });
      await queryClient.invalidateQueries({ queryKey: ["me", "settings"] });
    })().catch(() => {
      // Not worth interrupting anyone over; the organization default applies.
    });
    return () => {
      cancelled = true;
    };
  }, [ready, api, queryClient]);
}

export function App() {
  const me = useMe();
  useFirstVisitTimeZone(me.data?.billingStatus === "active");

  let page;
  if (me.isLoading) {
    page = <Notice title="Loading…">Getting your account.</Notice>;
  } else if (me.error) {
    page = <Notice title="Couldn't load your account">{me.error.message}</Notice>;
  } else if (me.data?.billingStatus !== "active") {
    page = (
      <Notice title="This account is locked">
        Ask your organization's admin to update the billing details to restore access.
      </Notice>
    );
  } else {
    page = (
      <Switch>
        <Route path="/leads" component={LeadsPage} />
        <Route path="/contacts" component={ContactsPage} />
        <Route path="/accounts" component={AccountsPage} />
        <Route path="/templates" component={TemplatesPage} />
        <Route path="/sequences" component={SequencesPage} />
        <Route path="/sequences/:id" component={SequenceDetailPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/admin" component={AdminPage} />
        <Route path="/">
          <Redirect to="/leads" />
        </Route>
        <Route>
          <Notice title="Page not found">That address doesn't match a page in Bagger.</Notice>
        </Route>
      </Switch>
    );
  }
  return <AppLayout>{page}</AppLayout>;
}
