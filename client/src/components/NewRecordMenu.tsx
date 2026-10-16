import {
  Building2,
  CalendarCheck,
  CircleDollarSign,
  Plus,
  UserPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { permissionsFor, useMe } from "@/lib/api";

/**
 * The + beside Roll the Calls: add an activity, lead, contact, account or
 * opportunity from anywhere. Each opens that list with its new-record form.
 */

const ITEMS: {
  object: "activities" | "leads" | "contacts" | "accounts" | "opportunities";
  label: string;
  icon: LucideIcon;
}[] = [
  { object: "activities", label: "Activity", icon: CalendarCheck },
  { object: "leads", label: "Lead", icon: UserPlus },
  { object: "contacts", label: "Contact", icon: Users },
  { object: "accounts", label: "Account", icon: Building2 },
  { object: "opportunities", label: "Opportunity", icon: CircleDollarSign },
];

export function NewRecordMenu() {
  const { data: me } = useMe();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const items = ITEMS.filter((i) => permissionsFor(me, i.object).canCreate);
  if (items.length === 0) return null;
  return (
    <div className="relative" ref={box}>
      <Button
        type="button"
        size="icon"
        aria-label="Add new"
        title="Add new"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Plus className="h-5 w-5" aria-hidden />
      </Button>
      {open && (
        <ul
          role="menu"
          aria-label="Add new"
          className="absolute right-0 z-30 mt-1 w-48 rounded-md border bg-background p-1 shadow-lg"
        >
          {items.map(({ object, label, icon: Icon }) => (
            <li key={object} role="none">
              <button
                type="button"
                role="menuitem"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  setOpen(false);
                  navigate(`/${object}?new=1`);
                }}
              >
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
