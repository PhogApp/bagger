/**
 * Due-date arithmetic for sequences.
 *
 * Dates are plain calendar dates ("YYYY-MM-DD") in the organization's time
 * zone. Keeping them as dates, not instants, means "2 days later" can never
 * drift because of a server's clock or daylight saving.
 */

export type WaitDayMode = "business" | "calendar";

/** The calendar date it is right now in the given IANA time zone. */
export function localDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function toUtc(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Add a step's wait to a start date.
 *
 * calendar: start + N days, weekends included.
 * business: start + N weekdays. A result never lands on a weekend, so a
 *           zero-day wait that starts on Saturday is due Monday.
 */
export function addWaitDays(start: string, waitDays: number, mode: WaitDayMode): string {
  if (!Number.isInteger(waitDays) || waitDays < 0) {
    throw new Error(`waitDays must be a non-negative integer, got ${waitDays}`);
  }
  const d = toUtc(start);
  if (mode === "calendar") {
    d.setUTCDate(d.getUTCDate() + waitDays);
    return fromUtc(d);
  }
  let remaining = waitDays;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) remaining--;
  }
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() + 1);
  return fromUtc(d);
}
