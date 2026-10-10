import {
  Building2,
  FileText,
  Landmark,
  ListOrdered,
  ShieldCheck,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { isAdmin, useMe } from "@/lib/api";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Brand } from "./Brand";
import { RunStepsButton } from "./RunSteps";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/leads", label: "Leads", icon: UserPlus },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/accounts", label: "Accounts", icon: Building2 },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/sequences", label: "Sequences", icon: ListOrdered },
];

const itemClass = (active: boolean) =>
  cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
    active
      ? "bg-brand-ocean font-medium text-white"
      : "text-white/75 hover:bg-white/10 hover:text-white",
  );

/** The user's photo, or their initial in a circle. */
export function Avatar({ name, imageUrl }: { name: string; imageUrl?: string }) {
  return imageUrl ? (
    <img src={imageUrl} alt="" className="h-7 w-7 shrink-0 rounded-full object-cover" />
  ) : (
    <span
      aria-hidden
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-teal text-xs font-semibold text-white"
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { userName, userImageUrl, orgName, orgLogoUrl } = useSession();
  const { data: me } = useMe();
  const at = (href: string) => location === href || location.startsWith(`${href}/`);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b bg-background px-6">
        <div className="flex items-center gap-4">
          <Brand />
          {orgLogoUrl && (
            <>
              <span className="h-8 w-px bg-border" aria-hidden />
              <img
                src={orgLogoUrl}
                alt={orgName}
                title={orgName}
                className="h-9 max-w-40 rounded object-contain"
              />
            </>
          )}
        </div>
        <RunStepsButton />
      </header>
      <div className="flex flex-1">
        <nav
          className="sticky top-16 flex h-[calc(100vh-4rem)] w-56 shrink-0 flex-col bg-brand-deep p-3"
          aria-label="Main"
        >
          <div className="flex-1 space-y-0.5 overflow-y-auto">
            {NAV.map(({ href, label, icon: Icon }) => (
              <Link key={href} href={href} className={itemClass(at(href))}>
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </Link>
            ))}
          </div>

          <div className="space-y-0.5 border-t border-white/15 pt-3">
            {me?.isOwner && (
              <Link href="/organization" className={itemClass(at("/organization"))}>
                <Landmark className="h-4 w-4" aria-hidden />
                Organization
              </Link>
            )}
            {isAdmin(me) && (
              <Link href="/admin" className={itemClass(at("/admin"))}>
                <ShieldCheck className="h-4 w-4" aria-hidden />
                Admin
              </Link>
            )}
            <Link
              href="/settings"
              className={cn(itemClass(at("/settings")), "py-1.5")}
              title={userName}
            >
              <Avatar name={userName} imageUrl={userImageUrl} />
              <span className="min-w-0">
                <span className="block leading-tight">Settings</span>
                <span className="block truncate text-xs font-normal leading-tight opacity-75">
                  {userName}
                </span>
              </span>
            </Link>
          </div>
        </nav>
        <main className="min-w-0 flex-1 bg-muted/60">{children}</main>
      </div>
    </div>
  );
}
