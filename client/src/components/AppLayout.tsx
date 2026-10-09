import {
  Building2,
  FileText,
  ListOrdered,
  Settings,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
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
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { accountControls } = useSession();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
        <Brand />
        <div className="flex items-center gap-4">
          <RunStepsButton />
          {accountControls}
        </div>
      </header>
      <div className="flex flex-1">
        <nav className="w-56 shrink-0 bg-brand-deep p-3" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = location === href || location.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                  active
                    ? "bg-brand-ocean font-medium text-white"
                    : "text-white/75 hover:bg-white/10 hover:text-white",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>
        <main className="min-w-0 flex-1 bg-muted/60">{children}</main>
      </div>
    </div>
  );
}
