import { describe, expect, it } from "vitest";
import { addWaitDays, localDate } from "../server/sequences/dates";

// 2026-10-05 is a Monday.
describe("addWaitDays", () => {
  it("calendar mode counts every day", () => {
    expect(addWaitDays("2026-10-08", 2, "calendar")).toBe("2026-10-10"); // Thu -> Sat
    expect(addWaitDays("2026-10-05", 0, "calendar")).toBe("2026-10-05");
  });

  it("business mode skips weekends", () => {
    expect(addWaitDays("2026-10-08", 2, "business")).toBe("2026-10-12"); // Thu -> Mon
    expect(addWaitDays("2026-10-09", 1, "business")).toBe("2026-10-12"); // Fri -> Mon
    expect(addWaitDays("2026-10-05", 5, "business")).toBe("2026-10-12"); // Mon -> next Mon
  });

  it("business mode never lands on a weekend, even with no wait", () => {
    expect(addWaitDays("2026-10-10", 0, "business")).toBe("2026-10-12"); // Sat -> Mon
    expect(addWaitDays("2026-10-11", 0, "business")).toBe("2026-10-12"); // Sun -> Mon
    expect(addWaitDays("2026-10-10", 0, "calendar")).toBe("2026-10-10");
  });

  it("crosses month and year boundaries", () => {
    expect(addWaitDays("2026-12-31", 1, "business")).toBe("2027-01-01"); // Thu -> Fri
    expect(addWaitDays("2026-02-27", 2, "calendar")).toBe("2026-03-01");
  });

  it("rejects negative or fractional waits", () => {
    expect(() => addWaitDays("2026-10-05", -1, "calendar")).toThrow();
    expect(() => addWaitDays("2026-10-05", 1.5, "business")).toThrow();
  });
});

describe("localDate", () => {
  it("uses the organization's time zone, not UTC", () => {
    // 03:00 UTC on the 6th is still the evening of the 5th in Chicago.
    const instant = new Date("2026-10-06T03:00:00Z");
    expect(localDate(instant, "America/Chicago")).toBe("2026-10-05");
    expect(localDate(instant, "UTC")).toBe("2026-10-06");
  });
});
