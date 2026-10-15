import { Route, Switch, useLocation } from "wouter";
import { AppLayout } from "./components/AppLayout";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useApi, useMe } from "./lib/api";
import { Toaster } from "./lib/toast";
import { FullExportButton } from "./components/DataExport";
import { Button } from "./components/ui/button";
import { BillingPanel, CardReturn, useAddCard } from "./components/BillingPanel";
import type { Me } from "./lib/api";
import { AccountDetailPage, AccountsPage } from "./pages/Accounts";
import { ActivitiesPage } from "./pages/Activities";
import { ContactDetailPage, ContactsPage } from "./pages/Contacts";
import { DashboardPage } from "./pages/Dashboard";
import { IntegrationCallbackPage, IntegrationsPage } from "./pages/Integrations";
import { LeadDetailPage, LeadsPage } from "./pages/Leads";
import { OpportunitiesPage, OpportunityDetailPage } from "./pages/Opportunities";
import { OrganizationPage } from "./pages/Organization";
import { ReportBuilderPage } from "./pages/ReportBuilder";
import { ReportsPage } from "./pages/Reports";
import { SequenceDetailPage } from "./pages/SequenceDetail";
import { SequencesPage } from "./pages/Sequences";
import { StaffOrgPage, StaffPage } from "./pages/Staff";
import { AdminPage, browserTimeZone, SettingsPage } from "./pages/Settings";
import { TemplateDetailPage, TemplatesPage } from "./pages/Templates";

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
  const [location] = useLocation();
  // The staff console opens whatever state the staff member's own organization is in.
  const staffPage = me.data?.isStaff && (location === "/staff" || location.startsWith("/staff/"));
  useFirstVisitTimeZone(me.data?.billingStatus === "active");

  let page;
  if (me.isLoading) {
    page = <Notice title="Loading…">Getting your account.</Notice>;
  } else if (me.error) {
    page = <Notice title="Couldn't load your account">{me.error.message}</Notice>;
  } else if (staffPage) {
    page = (
      <Switch>
        <Route path="/staff" component={StaffPage} />
        <Route path="/staff/:id" component={StaffOrgPage} />
      </Switch>
    );
  } else if (me.data?.billingStatus !== "active") {
    page = <AccountGate me={me.data!} />;
  } else {
    page = (
      <Switch>
        <Route path="/leads" component={LeadsPage} />
        <Route path="/leads/:id" component={LeadDetailPage} />
        <Route path="/contacts" component={ContactsPage} />
        <Route path="/contacts/:id" component={ContactDetailPage} />
        <Route path="/accounts" component={AccountsPage} />
        <Route path="/accounts/:id" component={AccountDetailPage} />
        <Route path="/opportunities" component={OpportunitiesPage} />
        <Route path="/opportunities/:id" component={OpportunityDetailPage} />
        <Route path="/activities" component={ActivitiesPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/reports/custom/:id" component={ReportBuilderPage} />
        <Route path="/templates" component={TemplatesPage} />
        <Route path="/templates/:id" component={TemplateDetailPage} />
        <Route path="/sequences" component={SequencesPage} />
        <Route path="/sequences/:id" component={SequenceDetailPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/admin" component={AdminPage} />
        {me.data?.features?.integrations && (
          <Route path="/admin/integrations" component={IntegrationsPage} />
        )}
        {me.data?.features?.integrations && (
          <Route path="/integrations/callback" component={IntegrationCallbackPage} />
        )}
        <Route path="/organization" component={OrganizationPage} />
        <Route path="/" component={DashboardPage} />
        <Route>
          <Notice title="Page not found">That address doesn't match a page in Bagger.</Notice>
        </Route>
      </Switch>
    );
  }
  return (
    <>
      <CardReturn />
      <AppLayout>{page}</AppLayout>
      <Toaster />
    </>
  );
}

const GATE_TITLE = {
  setup: "Add a card to start your free week",
  locked: "This account is locked",
  cancelled: "This account is cancelled",
} as const;

/**
 * An account that isn't open: waiting for a card, locked by a failed charge,
 * or cancelled. The owner can put it right from here; admins can still take
 * all the data; everyone else is told who to ask.
 */
function AccountGate({ me }: { me: Me }) {
  const status = me.billingStatus as keyof typeof GATE_TITLE;
  const canExport = me.permissions["account.full_export"] === true;
  const addCard = useAddCard();
  const text = me.isOwner
    ? {
        setup:
          "Your first week is free. Bagger is then $7.99 per user per month: when the trial ends you're charged for the rest of that month, then on the 1st of each month. Cancel during the trial and nothing is charged.",
        locked: "The last charge didn't go through. Pay it below to open the account again.",
        cancelled: "Your data is kept. Reactivate below to pick up where you left off.",
      }[status]
    : {
        setup: "Your organization's owner needs to add a card before Bagger can be used.",
        locked: "Ask your organization's owner to update the card to restore access.",
        cancelled: "Your organization's account is cancelled. Ask its owner to reactivate it.",
      }[status];
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6 sm:p-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">{GATE_TITLE[status]}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{text}</p>
        {me.isOwner && status === "setup" && (
          <div className="mt-4 flex justify-center">
            <Button disabled={addCard.isPending} onClick={() => addCard.mutate()}>
              {addCard.isPending ? "Opening the card page…" : "Add a card"}
            </Button>
          </div>
        )}
      </div>
      {me.isOwner && status !== "setup" && (
        <section className="rounded-lg border bg-background p-5 text-left">
          <BillingPanel />
        </section>
      )}
      {canExport && status !== "setup" && (
        <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
          <span>Your data is safe. You can download all of it at any time.</span>
          <FullExportButton />
        </div>
      )}
    </div>
  );
}
