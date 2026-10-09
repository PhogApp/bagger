import { Redirect, Route, Switch } from "wouter";
import { AppLayout } from "./components/AppLayout";
import { useMe } from "./lib/api";
import { AccountsPage } from "./pages/Accounts";
import { ContactsPage } from "./pages/Contacts";
import { LeadsPage } from "./pages/Leads";

function Notice({ title, children }: { title: string; children: string }) {
  return (
    <div className="p-10 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

export function App() {
  const me = useMe();

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
