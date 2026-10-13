import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatPhoneNumber } from "../../../shared/phone";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Show a US number as (555) 123-4567; anything else is shown as typed. */
/** A phone number as text, the same way PhoneLink shows it. */
export function formatPhone(phone: string | null | undefined): string {
  return formatPhoneNumber(phone) || "—";
}

export function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "2026-12-15" as "Dec 15, 2026", without shifting it by the viewer's time zone. */
export function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Whole dollars: 12500 as "$12,500". */
export function formatMoney(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
