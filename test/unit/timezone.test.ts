import { describe, expect, it } from "vitest";
import { isWeekend, localDateString, zonedTimeToUtc } from "../../src/shared/timezone.js";

describe("zonedTimeToUtc", () => {
  it("converts a plain winter local time to the correct UTC instant (EST, UTC-5)", () => {
    const utc = zonedTimeToUtc("2026-01-15", "09:00", "America/New_York");
    expect(utc.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  it("converts a summer local time to the correct UTC instant (EDT, UTC-4)", () => {
    const utc = zonedTimeToUtc("2026-07-15", "09:00", "America/New_York");
    expect(utc.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });

  it("handles the spring-forward DST boundary (2026-03-08 in America/New_York)", () => {
    // Clocks jump 02:00 -> 03:00. A reminder at 09:00 local should land at 13:00 UTC
    // (already-advanced EDT offset), not 14:00 (the pre-transition EST offset).
    const utc = zonedTimeToUtc("2026-03-08", "09:00", "America/New_York");
    expect(utc.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("handles the fall-back DST boundary (2026-11-01 in America/New_York)", () => {
    const utc = zonedTimeToUtc("2026-11-01", "09:00", "America/New_York");
    expect(utc.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("is correct for a non-US timezone with a half-hour offset (Asia/Kolkata, UTC+5:30)", () => {
    const utc = zonedTimeToUtc("2026-06-01", "09:00", "Asia/Kolkata");
    expect(utc.toISOString()).toBe("2026-06-01T03:30:00.000Z");
  });
});

describe("localDateString", () => {
  it("reflects the target timezone's calendar date, not the server's", () => {
    // 2026-01-15T02:00:00Z is still 2026-01-14 evening in New York (UTC-5).
    const instant = new Date("2026-01-15T02:00:00.000Z");
    expect(localDateString(instant, "America/New_York")).toBe("2026-01-14");
    expect(localDateString(instant, "UTC")).toBe("2026-01-15");
  });
});

describe("isWeekend", () => {
  it("identifies Saturday/Sunday in the target timezone", () => {
    const saturday = new Date("2026-01-17T15:00:00.000Z");
    const monday = new Date("2026-01-19T15:00:00.000Z");
    expect(isWeekend(saturday, "America/New_York")).toBe(true);
    expect(isWeekend(monday, "America/New_York")).toBe(false);
  });
});
