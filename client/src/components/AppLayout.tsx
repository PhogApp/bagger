import { Building2, UserPlus, Users, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Brand } from "./Brand";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/leads", label: "Leads", icon: UserPlus },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/accounts", label: "Accounts", icon: Building2 },
];

export function AppLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { accountControls } = useSession();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-6">
        <Brand />
        <div className="flex items-center gap-4">{accountControls}</div>
      </header>
      <div className="flex flex-1">
        <nav className="w-56 shrink-0 border-r p-3" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = location === href || location.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm",
                  active
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
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
