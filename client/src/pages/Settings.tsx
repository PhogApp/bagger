import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LogOut } from "lucide-react";
import { Avatar } from "@/components/AppLayout";
import { FieldSettings } from "@/components/FieldSettings";
import { StatusSettings } from "@/components/StatusSettings";
import { canUse, isAdmin, useApi, useMe } from "@/lib/api";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { FullExportButton } from "@/components/DataExport";
import { PeopleSettings } from "@/components/PeopleSettings";

interface MySettings {
  timezone: string | null;
  effectiveTimezone: string;
  organizationDefault: string;
}
interface OrgSettings {
  waitDayMode: "business" | "calendar";
  timezone: string;
}

const selectClass =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function useTimeZones(...include: string[]): string[] {
  return useMemo(() => {
    const all = new Set<string>(Intl.supportedValuesOf("timeZone"));
    for (const zone of include) if (zone) all.add(zone);
    return [...all].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [include.join("|")]);
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-background">
      <div className="border-b p-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function MySettingsSection() {
  const api = useApi();
  const queryClient = useQueryClient();
  const mine = useQuery({
    queryKey: ["me", "settings"],
    queryFn: () => api<MySettings>("GET", "/api/me/settings"),
  });
  const [zone, setZone] = useState("");
  // Follow the saved value, but only when it actually changes, so a
  // background refresh never undoes a choice the user is in the middle of.
  const savedZone = mine.data?.effectiveTimezone;
  useEffect(() => {
    if (savedZone) setZone(savedZone);
  }, [savedZone]);
  const zones = useTimeZones(zone, browserTimeZone());

  const save = useMutation({
    mutationFn: () => api<MySettings>("PATCH", "/api/me/settings", { timezone: zone }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me", "settings"] });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast.success("Time zone saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Section
      title="My settings"
      description="These apply only to you, in every organization you belong to."
    >
      <div className="max-w-md space-y-1.5">
        <Label htmlFor="my-timezone">Time zone</Label>
        <select
          id="my-timezone"
          className={selectClass}
          value={zone}
          onChange={(e) => setZone(e.target.value)}
        >
          {zones.map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Decides when your steps become due and which day counts as "today" in Roll the Calls. Your
          browser reports {browserTimeZone().replace(/_/g, " ")}.
        </p>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || !zone || zone === mine.data?.timezone}
        >
          Save
        </Button>
      </div>
    </Section>
  );
}

function OrganizationSection({ canEdit }: { canEdit: boolean }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const org = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<OrgSettings>("GET", "/api/settings"),
  });
  const [form, setForm] = useState<OrgSettings | null>(null);
  const savedMode = org.data?.waitDayMode;
  const savedOrgZone = org.data?.timezone;
  useEffect(() => {
    if (savedMode && savedOrgZone) setForm({ waitDayMode: savedMode, timezone: savedOrgZone });
  }, [savedMode, savedOrgZone]);
  const zones = useTimeZones(form?.timezone ?? "");

  const save = useMutation({
    mutationFn: () => api<OrgSettings>("PATCH", "/api/settings", form),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Organization settings saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!form) return null;
  const unchanged =
    form.waitDayMode === org.data?.waitDayMode && form.timezone === org.data?.timezone;

  return (
    <Section
      title="Organization"
      description={
        canEdit
          ? "These apply to everyone in your organization."
          : "Set by your organization's admin."
      }
    >
      <fieldset disabled={!canEdit} className="space-y-3">
        <legend className="text-sm font-medium">Wait days between sequence steps</legend>
        {(
          [
            [
              "business",
              "Business days",
              "Weekends are skipped. A 2-day wait after a Thursday step is due Monday.",
            ],
            [
              "calendar",
              "Calendar days",
              "Every day counts. A 2-day wait after a Thursday step is due Saturday.",
            ],
          ] as const
        ).map(([value, label, help]) => (
          <label key={value} className="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              name="waitDayMode"
              className="mt-1"
              checked={form.waitDayMode === value}
              onChange={() => setForm({ ...form, waitDayMode: value })}
            />
            <span>
              <span className="text-sm font-medium">{label}</span>
              <span className="block text-sm text-muted-foreground">{help}</span>
            </span>
          </label>
        ))}
        <p className="text-xs text-muted-foreground">
          A change applies to steps created from now on. Steps already waiting keep their due date.
        </p>

        <div className="max-w-md space-y-1.5 pt-2">
          <Label htmlFor="org-timezone">Default time zone</Label>
          <select
            id="org-timezone"
            className={selectClass}
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Used for anyone who has not chosen their own time zone.
          </p>
        </div>
      </fieldset>
      {canEdit && (
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={save.isPending || unchanged}>
            Save
          </Button>
        </div>
      )}
    </Section>
  );
}

function AccountSection() {
  const { data: me } = useMe();
  const { userName, userImageUrl, orgName, orgSwitcher, manageAccount, signOut } = useSession();
  return (
    <Section title="Account" description="Who you are signed in as.">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Avatar name={userName} imageUrl={userImageUrl} />
          <div>
            <p className="text-sm font-medium">{userName}</p>
            <p className="text-sm text-muted-foreground">
              {me?.user.email} · {me?.role} at {orgName}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {manageAccount && (
            <Button variant="outline" onClick={manageAccount}>
              Manage account
            </Button>
          )}
          {signOut && (
            <Button variant="outline" onClick={signOut}>
              <LogOut className="mr-2 h-4 w-4" aria-hidden />
              Sign out
            </Button>
          )}
        </div>
      </div>
      {orgSwitcher && (
        <div className="mt-4 flex items-center gap-3 border-t pt-4">
          <span className="text-sm text-muted-foreground">Organization</span>
          {orgSwitcher}
        </div>
      )}
    </Section>
  );
}

function PageHeader({ title }: { title: string }) {
  return (
    <div className="border-b bg-background px-6 py-4">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    </div>
  );
}

/** Personal settings: visible to everyone. */
export function SettingsPage() {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="max-w-4xl space-y-6 p-6">
        <AccountSection />
        <MySettingsSection />
      </div>
    </div>
  );
}

/** Organization settings and users: visible to admins only. */
export function AdminPage() {
  const { data: me } = useMe();
  if (!me) return null;
  if (!isAdmin(me)) {
    return (
      <div className="p-10 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Admins only</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask an admin in your organization if something here needs changing.
        </p>
      </div>
    );
  }
  return (
    <div>
      <PageHeader title="Admin" />
      <div className="max-w-4xl space-y-6 p-6">
        <OrganizationSection canEdit={canUse(me, "setup.org_settings")} />
        <StatusSettings canEdit={canUse(me, "setup.org_settings")} />
        {canUse(me, "setup.org_settings") && <FieldSettings />}
        <PeopleSettings canManage={canUse(me, "account.users_and_roles")} />
        {canUse(me, "account.full_export") && (
          <Section
            title="Export all data"
            description="Every lead, contact, account, opportunity, activity, template and sequence, with all change history, as CSV files in one ZIP. Available any time, even if the account is locked."
          >
            <FullExportButton />
          </Section>
        )}
      </div>
    </div>
  );
}
