import { describe, expect, it } from "vitest";
import { formatPhoneNumber, parsePhone } from "../shared/phone";

describe("reading phone numbers", () => {
  it("reads a 10-digit US number however it was typed", () => {
    for (const typed of [
      "8165551234",
      "816-555-1234",
      "816.555.1234",
      "(816) 555-1234",
      " (816)555 1234 ",
      "1-816-555-1234",
      "+1 816 555 1234",
      "816/555-1234",
    ]) {
      expect(parsePhone(typed), typed).toEqual({
        display: "(816) 555-1234",
        e164: "+18165551234",
        ext: null,
      });
    }
  });

  it("keeps a number already in E.164 form", () => {
    expect(parsePhone("+18165551234")).toMatchObject({ e164: "+18165551234" });
    expect(parsePhone("+44 20 7946 0958")).toEqual({
      display: "+44 20 7946 0958",
      e164: "+442079460958",
      ext: null,
    });
  });

  it("dials the main number and shows the extension", () => {
    for (const typed of [
      "816-555-1234 x204",
      "816-555-1234x204",
      "(816) 555-1234 ext. 204",
      "816 555 1234 ext 204",
      "8165551234 extension 204",
      "816-555-1234 #204",
    ]) {
      expect(parsePhone(typed), typed).toEqual({
        display: "(816) 555-1234",
        e164: "+18165551234",
        ext: "204",
      });
    }
    expect(formatPhoneNumber("816-555-1234 x204")).toBe("(816) 555-1234 ext. 204");
  });

  it("leaves anything it can't read as typed", () => {
    for (const typed of [
      "",
      "   ",
      "555-1234",
      "call the front desk",
      "816-555-12345",
      "123-555-1234",
      "+0 123 456 789",
      "+1234",
      "816-555-1234 ask for Bob",
    ]) {
      expect(parsePhone(typed), typed).toBeNull();
    }
    expect(parsePhone(null)).toBeNull();
    expect(formatPhoneNumber("call the front desk")).toBe("call the front desk");
    expect(formatPhoneNumber(null)).toBe("");
  });
});
